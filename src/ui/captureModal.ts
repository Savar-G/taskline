import { App, Modal, Platform } from "obsidian";
import type VaultTasksPlugin from "../main";
import { VtTask } from "../model";
import { appendUnderHeading, VtStaleError } from "../writer";
import { CaptureToken, knownCaptureTags, ParsedCapture, parseCapture, serializeCapturedTask, suggestArea } from "../captureRules";
import { buildTaskRow } from "./taskRow";
import { areaColor } from "./areaColor";
import { prefersReducedMotion } from "./motion";

const PREVIEW_DEBOUNCE_MS = 90;
const PREVIEW_XFADE_MS = 120;

function todayIso(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** CSS class for a token span in the highlight backdrop. Priority level comes from the parse
 * result (the token itself is level-agnostic) so the tint matches the resolved priority. */
function tokenClass(tok: CaptureToken, parsed: ParsedCapture): string {
  switch (tok.type) {
    case "date":
      return "vt-tok vt-tok--date";
    case "scheduled":
      return "vt-tok vt-tok--scheduled";
    case "area":
      return "vt-tok vt-tok--area";
    case "recurrence":
      return "vt-tok vt-tok--recurrence";
    case "owner":
      return "vt-tok vt-tok--owner";
    case "priority":
      return `vt-tok vt-tok--priority-${parsed.priority ?? "p3"}`;
  }
}

/** Builds a display-only VtTask from a parse result so the preview reuses the real row
 * component. Never written anywhere - filePath/lineNo are empty sentinels. */
function previewTask(parsed: ParsedCapture): VtTask {
  return {
    sourceId: parsed.destination?.sourceId ?? "",
    filePath: "",
    lineNo: 0,
    rawLine: "",
    status: "todo",
    statusChar: " ",
    title: parsed.title,
    tags: parsed.tags,
    priority: parsed.priority,
    due: parsed.due,
    scheduled: parsed.scheduled,
    recurrence: parsed.recurrence,
    owner: parsed.owner,
    heading: "",
    subNotes: [],
  };
}

/** Shared machinery for the capture-grammar modals (quick-add + edit). Owns the live-highlight
 * input, the parsed-preview row and the honest destination line; subclasses supply the seed text
 * and the commit behavior. See DESIGN sections 3.4 / 5 / 7 / 9. */
export abstract class CaptureModalBase extends Modal {
  protected plugin: VaultTasksPlugin;
  private field!: HTMLElement;
  private backdrop!: HTMLElement;
  protected input!: HTMLInputElement | HTMLTextAreaElement;
  private previewWrap!: HTMLElement;
  protected destLine!: HTMLElement;
  private errorLine!: HTMLElement;
  private previewTimer: number | null = null;
  private cancelButton: HTMLButtonElement | null = null;
  private saveButton: HTMLButtonElement | null = null;
  private committing = false;
  private opened = false;
  private transientTimers = new Set<number>();

  // ---- '#' autocomplete menu (DESIGN §9.6) -----------------------------------
  private suggestMenu!: HTMLElement;
  private suggestIdPrefix = `vt-suggest-${Math.random().toString(36).slice(2)}`;
  private suggestOpen = false;
  private suggestContext: { start: number; end: number } | null = null;
  private suggestFiltered: string[] = [];
  private suggestOptionEls: HTMLElement[] = [];
  private suggestActiveIndex = -1;

  constructor(app: App, plugin: VaultTasksPlugin) {
    super(app);
    this.plugin = plugin;
  }

  /** Text the input is seeded with on open ("" for capture, the reconstructed grammar for edit). */
  protected abstract initialValue(): string;

  /** Placeholder for the empty input. */
  protected placeholder(): string {
    return "Add a task…";
  }

  /** Edit is a review-and-save task, not quick capture, so it gets explicit chrome. */
  protected modalTitle(): string | null {
    return null;
  }

  protected usesExplicitActions(): boolean {
    return false;
  }

  protected wrapsInput(): boolean {
    return false;
  }

  /** Optional controls inserted between the grammar field and preview. Edit uses this for
   * structured date/priority controls; capture intentionally leaves the slot empty. */
  protected buildSupplementalControls(_parent: HTMLElement): void {}

  /** Lets a subclass mirror the latest parse into structured controls without creating a
   * second source of truth. Called for initial state and every live refresh. */
  protected onParsedChange(_parsed: ParsedCapture): void {}

  protected inputValue(): string {
    return this.input.value;
  }

  /** Applies a structured-control change through the exact same highlight/preview pipeline as
   * typing. Keeping this in the base prevents date/priority controls from drifting from grammar. */
  protected replaceInputValue(value: string): void {
    this.input.value = value;
    const end = value.length;
    this.input.setSelectionRange(end, end);
    this.clearError();
    this.closeSuggestMenu();
    this.syncInputHeight();
    this.paintHighlight();
    this.refreshLive(true);
  }

  /** Shift+Enter keeps the modal open for rapid multi-add (capture only). */
  protected allowKeepOpen(): boolean {
    return false;
  }

  /** Persists the parse. Throws on write failure so the base keeps the modal open with the
   * muted inline error. Return value ignored. */
  protected abstract persist(parsed: ParsedCapture, raw: string): Promise<void>;

  close(): void {
    // A modal disappearing mid-write discards the user's only copy of a failed edit.
    if (this.committing) return;
    super.close();
  }

  onOpen(): void {
    this.opened = true;
    this.modalEl.addClass("vt-capture-modal");
    if (this.usesExplicitActions()) this.modalEl.addClass("vt-edit-modal");
    if (Platform.isMobile) this.modalEl.addClass("vt-capture-modal--sheet");
    if (prefersReducedMotion()) this.modalEl.addClass("vt-reduced");

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("vt-capture-content");

    const modalTitle = this.modalTitle();
    if (modalTitle) {
      const header = contentEl.createDiv({ cls: "vt-edit-header" });
      header.createEl("h2", { cls: "vt-edit-title", text: modalTitle });
      header.createDiv({ cls: "vt-edit-subtitle", text: "Update the task and review where it will be saved." });
    }

    // ---- input + highlight backdrop (mirror-overlay technique) ----
    this.field = contentEl.createDiv({ cls: "vt-capture-field" });
    this.backdrop = this.field.createDiv({ cls: "vt-capture-backdrop" });
    this.backdrop.setAttr("aria-hidden", "true");

    if (this.wrapsInput()) {
      const textarea = this.field.createEl("textarea", { cls: "vt-capture-input" });
      textarea.rows = 1;
      textarea.setAttr("aria-multiline", "false");
      this.input = textarea;
    } else {
      const input = this.field.createEl("input", { cls: "vt-capture-input" });
      input.type = "text";
      this.input = input;
    }
    this.input.placeholder = this.placeholder();
    this.input.setAttr("aria-label", this.placeholder());
    this.input.setAttr("autocomplete", "off");
    this.input.setAttr("autocapitalize", "off");
    this.input.setAttr("spellcheck", "false");

    if (!this.usesExplicitActions()) {
      const commitHint = this.field.createSpan({ cls: "vt-capture-hint" });
      commitHint.setText(Platform.isMobile ? "return" : "enter");
    }

    // ---- '#' autocomplete menu, anchored under the input (DESIGN §9.6) ----
    this.suggestMenu = this.field.createDiv({ cls: "vt-suggest-menu" });
    this.suggestMenu.id = `${this.suggestIdPrefix}-listbox`;
    this.suggestMenu.setAttr("role", "listbox");
    this.suggestMenu.hide();
    this.input.setAttr("aria-controls", this.suggestMenu.id);
    this.input.setAttr("aria-expanded", "false");

    this.buildSupplementalControls(contentEl);

    // ---- parsed-preview row (hidden until there is input) ----
    this.previewWrap = contentEl.createDiv({ cls: "vt-capture-preview" });
    this.previewWrap.setAttr("role", "list");
    this.previewWrap.hide();

    // ---- destination indicator (aria-live so routing changes are announced) ----
    this.destLine = contentEl.createDiv({ cls: "vt-capture-dest" });
    this.destLine.setAttr("role", "status");
    this.destLine.setAttr("aria-live", "polite");
    this.destLine.hide();

    // ---- inline error slot (muted, never a modal alarm) ----
    this.errorLine = contentEl.createDiv({ cls: "vt-capture-error" });
    this.errorLine.hide();

    if (this.usesExplicitActions()) {
      const footer = contentEl.createDiv({ cls: "vt-edit-footer" });
      footer.createSpan({ cls: "vt-edit-shortcuts", text: "Enter to save · Esc to cancel" });
      const actions = footer.createDiv({ cls: "vt-edit-actions" });
      this.cancelButton = actions.createEl("button", { cls: "vt-edit-cancel", text: "Cancel" });
      this.cancelButton.type = "button";
      this.cancelButton.addEventListener("click", () => this.close());
      this.saveButton = actions.createEl("button", { cls: "vt-edit-save", text: "Save" });
      this.saveButton.type = "button";
      this.saveButton.addEventListener("click", () => void this.commit(false));
    }

    this.input.addEventListener("input", this.onInput);
    this.input.addEventListener("keyup", this.onCaretMove);
    this.input.addEventListener("click", this.onCaretMove);
    this.input.addEventListener("scroll", this.syncScroll);
    this.input.addEventListener("keydown", this.onKeyDown);

    // Seed value, then place the caret at the end so the user can extend the phrase.
    this.input.value = this.initialValue();
    this.syncInputHeight();

    // Autofocus. Obsidian focuses the modal container on open; defer so ours wins.
    this.defer(() => {
      this.input.focus();
      const end = this.input.value.length;
      this.input.setSelectionRange(end, end);
    }, 0);
    this.paintHighlight();
    this.refreshLive(true);
  }

  onClose(): void {
    this.opened = false;
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    for (const timer of this.transientTimers) window.clearTimeout(timer);
    this.transientTimers.clear();
    this.contentEl.empty();
  }

  protected defer(callback: () => void, delay = 0): void {
    const timer = window.setTimeout(() => {
      this.transientTimers.delete(timer);
      if (this.opened) callback();
    }, delay);
    this.transientTimers.add(timer);
  }

  // ---- live update pipeline -------------------------------------------------

  private onInput = (): void => {
    const caret = this.input.selectionStart ?? this.input.value.length;
    const singleLine = this.input.value.replace(/\s*[\r\n]+\s*/g, " ");
    if (singleLine !== this.input.value) {
      this.input.value = singleLine;
      this.input.setSelectionRange(Math.min(caret, singleLine.length), Math.min(caret, singleLine.length));
    }
    this.clearError();
    this.syncInputHeight();
    this.paintHighlight();
    this.schedulePreview();
    this.refreshHashSuggest(true);
  };

  private onCaretMove = (): void => {
    // Caret moved without editing: only the active-token tint changes, cheap to repaint.
    this.paintHighlight();
    this.refreshHashSuggest(false);
  };

  private syncScroll = (): void => {
    this.backdrop.scrollLeft = this.input.scrollLeft;
    this.backdrop.scrollTop = this.input.scrollTop;
  };

  private syncInputHeight(): void {
    if (!this.wrapsInput()) return;
    this.input.setCssStyles({ height: "auto" });
    this.input.setCssStyles({ height: `${Math.min(this.input.scrollHeight, 160)}px` });
  }

  /** Repaints the highlight backdrop from the current parse. Synchronous and cheap so typing
   * is never gated on the debounced preview (DESIGN anti-pattern 5). */
  private paintHighlight(): void {
    const text = this.input.value;
    const caret = this.input.selectionStart ?? text.length;
    const parsed = parseCapture(text, new Date(), this.plugin.workspace);

    this.backdrop.empty();
    let pos = 0;
    for (const tok of parsed.tokens) {
      if (tok.start > pos) this.backdrop.appendText(text.slice(pos, tok.start));
      const span = this.backdrop.createSpan({
        cls: tokenClass(tok, parsed),
        text: text.slice(tok.start, tok.end),
      });
      if (caret >= tok.start && caret <= tok.end) span.addClass("vt-tok--active");
      pos = tok.end;
    }
    if (pos < text.length) this.backdrop.appendText(text.slice(pos));
    this.syncScroll();
  }

  private schedulePreview(): void {
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      this.refreshLive(false);
    }, PREVIEW_DEBOUNCE_MS);
  }

  /** Rebuilds the preview row + destination line from the current parse. `immediate` skips the
   * crossfade (used on open). Crossfades the whole preview block (a lightweight stand-in for
   * the ideal metadata-only xfade). */
  private refreshLive(immediate: boolean): void {
    const text = this.input.value;
    const parsed = parseCapture(text, new Date(), this.plugin.workspace);
    const empty = text.trim().length === 0;
    this.onParsedChange(parsed);

    if (empty) {
      this.previewWrap.hide();
      this.destLine.hide();
      return;
    }

    // preview row
    this.previewWrap.empty();
    this.previewWrap.show();
    const previewRow = buildTaskRow(this.previewWrap, previewTask(parsed), new Date(), {
      onComplete: () => {},
      onStatusMenu: () => {},
    }, this.plugin.workspace);
    this.stripPreviewInteractivity(previewRow);
    if (!immediate && !prefersReducedMotion()) {
      this.previewWrap.addClass("vt-xfade");
      this.defer(() => this.previewWrap.removeClass("vt-xfade"), PREVIEW_XFADE_MS);
    }

    // destination line
    this.destLine.empty();
    this.destLine.show();
    this.renderDestination(parsed);
  }

  /** The preview row reuses buildTaskRow's real markup for visual fidelity, but it is
   * display-only: strip the interactive semantics (role/aria-checked/aria-label/click) so
   * assistive tech and pointer input never treat it as a live control. Does not touch
   * buildTaskRow itself - the live Today-view row keeps its full interactivity. */
  private stripPreviewInteractivity(row: HTMLElement): void {
    row.removeAttribute("tabindex");
    row.setAttr("aria-hidden", "true");
    const ring = row.querySelector<HTMLElement>(".vt-ring");
    if (ring) {
      ring.removeAttribute("role");
      ring.removeAttribute("aria-checked");
      ring.removeAttribute("aria-label");
      ring.removeAttribute("tabindex");
    }
  }

  protected renderDestination(parsed: ParsedCapture): void {
    const verb = this.destinationVerb();
    const arrow = this.destLine.createSpan({ cls: "vt-dest-arrow", text: "→" });
    arrow.setAttr("aria-hidden", "true");

    if (!parsed.destination) {
      this.destLine.addClass("vt-dest--inbox");
      const suggestion = suggestArea(this.input.value, this.plugin.workspace);
      if (suggestion) {
        this.destLine.createSpan({ cls: "vt-dest-label", text: `${verb} requires a destination · Tab routes as` });
        const tag = this.destLine.createSpan({
          cls: "vt-dest-suggest-tag",
          text: `#${suggestion.tag}`,
        });
        tag.style.color = areaColor(suggestion.tag, this.plugin.workspace);
      } else {
        this.destLine.createSpan({ cls: "vt-dest-label", text: "No capture destination configured" });
        this.destLine.createSpan({ cls: "vt-dest-hint", text: "Open Taskline settings." });
      }
      return;
    }

    const source = this.plugin.workspace.sourceById.get(parsed.destination.sourceId);
    this.destLine.removeClass("vt-dest--inbox");
    this.destLine.createSpan({ cls: "vt-dest-label", text: `${verb} to ${source?.label ?? parsed.destination.sourceId}` });
    this.destLine.createSpan({ cls: "vt-dest-sep", text: "›" });
    this.destLine.createSpan({ cls: "vt-dest-section", text: parsed.destination.heading });
  }

  /** Routing verb in the destination line ("filing" for capture, "saving" for edit). */
  protected destinationVerb(): string {
    return "filing";
  }

  // ---- '#' autocomplete menu (DESIGN §9.6) -----------------------------------

  /** Finds the '#area' token the caret is in or immediately after, if any. `start`/`end` bound
   * the whole tag (including the '#') so an accepted suggestion can replace it wholesale;
   * `prefix` is only the typed characters between '#' and the caret, used to filter. */
  private activeHashQuery(text: string, caret: number): { start: number; end: number; prefix: string } | null {
    let wordStart = caret;
    while (wordStart > 0 && /[\w/-]/.test(text[wordStart - 1])) wordStart--;
    if (wordStart === 0 || text[wordStart - 1] !== "#") return null;

    let wordEnd = caret;
    while (wordEnd < text.length && /[\w/-]/.test(text[wordEnd])) wordEnd++;

    return { start: wordStart - 1, end: wordEnd, prefix: text.slice(wordStart, caret) };
  }

  /** Recomputes the autocomplete menu from the current text + caret. `forceReset` (true from
   * onInput) always re-filters and re-selects the first option; false (from onCaretMove) skips
   * the rebuild when the hash-token span hasn't actually changed, so our own ArrowUp/Down
   * handling (which keeps the caret in place and relies on the subsequent keyup no-op) never
   * stomps the user's menu selection. */
  private refreshHashSuggest(forceReset: boolean): void {
    const text = this.input.value;
    const caret = this.input.selectionStart ?? text.length;
    const ctx = this.activeHashQuery(text, caret);

    if (!ctx) {
      this.closeSuggestMenu();
      return;
    }

    const unchanged =
      !forceReset &&
      this.suggestContext !== null &&
      this.suggestContext.start === ctx.start &&
      this.suggestContext.end === ctx.end;
    if (unchanged) return;

    const prefix = ctx.prefix.toLowerCase();
    const filtered = knownCaptureTags(this.plugin.workspace).filter((a) => a.startsWith(prefix)).slice(0, 6);
    if (filtered.length === 0) {
      this.closeSuggestMenu();
      return;
    }

    this.suggestContext = { start: ctx.start, end: ctx.end };
    this.suggestFiltered = filtered;
    this.suggestActiveIndex = 0;
    this.renderSuggestOptions(filtered);
    this.openSuggestMenu();
  }

  private renderSuggestOptions(areas: readonly string[]): void {
    this.suggestMenu.empty();
    this.suggestOptionEls = [];
    areas.forEach((area, idx) => {
      const opt = this.suggestMenu.createDiv({ cls: "vt-suggest-option" });
      opt.id = `${this.suggestIdPrefix}-opt-${idx}`;
      opt.setAttr("role", "option");
      const hash = opt.createSpan({ cls: "vt-suggest-hash", text: "#" });
      hash.style.color = areaColor(area, this.plugin.workspace);
      opt.createSpan({ cls: "vt-suggest-area", text: area });
      opt.addEventListener("mousedown", (ev) => {
        // Prevent the input from losing focus before we can act on the click.
        ev.preventDefault();
        this.acceptSuggestion(area);
      });
      this.suggestOptionEls.push(opt);
    });
    this.updateActiveOption();
  }

  private updateActiveOption(): void {
    this.suggestOptionEls.forEach((opt, idx) => {
      const active = idx === this.suggestActiveIndex;
      opt.toggleClass("vt-suggest-option--active", active);
      opt.setAttr("aria-selected", active ? "true" : "false");
    });
    const active = this.suggestOptionEls[this.suggestActiveIndex];
    if (active) this.input.setAttr("aria-activedescendant", active.id);
    else this.input.removeAttribute("aria-activedescendant");
  }

  private openSuggestMenu(): void {
    this.suggestOpen = true;
    this.suggestMenu.show();
    this.input.setAttr("aria-expanded", "true");
  }

  private closeSuggestMenu(): void {
    if (!this.suggestOpen && this.suggestContext === null) return;
    this.suggestOpen = false;
    this.suggestContext = null;
    this.suggestFiltered = [];
    this.suggestOptionEls = [];
    this.suggestActiveIndex = -1;
    this.suggestMenu.hide();
    this.suggestMenu.empty();
    this.input.setAttr("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
  }

  private moveSuggestActive(delta: number): void {
    const len = this.suggestOptionEls.length;
    if (len === 0) return;
    if (this.suggestActiveIndex === -1) this.suggestActiveIndex = delta > 0 ? 0 : len - 1;
    else this.suggestActiveIndex = (this.suggestActiveIndex + delta + len) % len;
    this.updateActiveOption();
  }

  private acceptActiveSuggestion(): void {
    const idx = this.suggestActiveIndex === -1 ? 0 : this.suggestActiveIndex;
    const area = this.suggestFiltered[idx];
    if (area) this.acceptSuggestion(area);
    else this.closeSuggestMenu();
  }

  /** Replaces the in-progress '#tag' span with the full tag + a trailing space, then re-runs
   * the same live pipeline a normal keystroke would (highlight + preview + destination). */
  private acceptSuggestion(area: string): void {
    const ctx = this.suggestContext;
    this.closeSuggestMenu();
    if (!ctx) return;

    const text = this.input.value;
    const insertion = `#${area} `;
    const newValue = text.slice(0, ctx.start) + insertion + text.slice(ctx.end);
    const caretPos = ctx.start + insertion.length;

    this.input.value = newValue;
    this.input.setSelectionRange(caretPos, caretPos);
    this.input.focus();
    this.clearError();
    this.paintHighlight();
    this.refreshLive(true);
  }

  // ---- keyword area suggestion (Tab to file) - DESIGN §9.6 -------------------

  /** Applies the keyword-derived suggestArea hit (if any) by appending ' #<area>' to the input
   * and re-running the live pipeline immediately - the same routing pipeline capture already
   * uses picks the new destination up on its own. No-op when there is nothing to apply. */
  private applyKeywordSuggestion(): boolean {
    const text = this.input.value;
    const parsed = parseCapture(text, new Date(), this.plugin.workspace);
    const fallback = this.plugin.settings.fallbackCaptureDestination;
    if (parsed.destination && JSON.stringify(parsed.destination) !== JSON.stringify(fallback)) return false;
    const suggestion = suggestArea(text, this.plugin.workspace);
    if (!suggestion) return false;

    const newValue = `${text} #${suggestion.tag}`;
    this.input.value = newValue;
    const end = newValue.length;
    this.input.setSelectionRange(end, end);
    this.input.focus();
    this.clearError();
    this.paintHighlight();
    this.refreshLive(true);
    return true;
  }

  // ---- commit ---------------------------------------------------------------

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.isComposing) return;

    if (this.suggestOpen) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        this.moveSuggestActive(1);
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        this.moveSuggestActive(-1);
        return;
      }
      if (ev.key === "Tab" && !ev.shiftKey) {
        ev.preventDefault();
        this.acceptActiveSuggestion();
        return;
      }
      if (ev.key === "Enter") {
        // Menu is open: Enter accepts the highlighted option and must NOT also commit the capture.
        ev.preventDefault();
        this.acceptActiveSuggestion();
        return;
      }
      if (ev.key === "Escape") {
        // Closes the menu only; stop the event reaching Obsidian's modal-level Escape handler.
        ev.preventDefault();
        ev.stopPropagation();
        this.closeSuggestMenu();
        return;
      }
    }

    if (ev.key === "Tab" && !ev.shiftKey) {
      const applied = this.applyKeywordSuggestion();
      if (applied || !this.usesExplicitActions()) ev.preventDefault();
      return;
    }

    if (ev.key !== "Enter") return;
    ev.preventDefault();
    void this.commit(this.allowKeepOpen() && ev.shiftKey);
  };

  protected async commit(keepOpen: boolean): Promise<void> {
    if (this.committing) return;
    const raw = this.input.value;
    if (raw.trim().length === 0) return; // empty + Enter = no-op

    const parsed = parseCapture(raw, new Date(), this.plugin.workspace);
    this.setCommitting(true);
    try {
      await this.persist(parsed, raw);
    } catch (err) {
      this.setCommitting(false);
      this.showError(err);
      this.input.focus();
      return; // keep the modal open, keep the text
    }

    if (keepOpen) {
      this.setCommitting(false);
      this.input.value = "";
      this.clearError();
      this.closeSuggestMenu();
      this.paintHighlight();
      this.refreshLive(true);
      this.input.focus();
    } else {
      this.setCommitting(false);
      this.close();
    }
  }

  private setCommitting(committing: boolean): void {
    this.committing = committing;
    this.modalEl.toggleClass("vt-edit-modal--saving", committing);
    const closeButton = this.modalEl.querySelector<HTMLElement>(".modal-close-button");
    if (closeButton) closeButton.setAttr("aria-disabled", committing ? "true" : "false");
    this.input.disabled = committing;
    if (this.cancelButton) this.cancelButton.disabled = committing;
    if (this.saveButton) {
      this.saveButton.disabled = committing;
      this.saveButton.setText(committing ? "Saving…" : "Save");
    }
  }

  // ---- inline error ---------------------------------------------------------

  protected showError(err: unknown): void {
    const reason =
      err instanceof VtStaleError || err instanceof Error
        ? err.message.replace(/^taskline:\s*/, "")
        : "unknown reason";
    this.errorLine.empty();
    this.errorLine.show();
    this.errorLine.setText(`${this.errorVerb()} - ${reason}. Kept your text.`);
  }

  protected errorVerb(): string {
    return "Could not file";
  }

  protected clearError(): void {
    if (this.errorLine) {
      this.errorLine.hide();
      this.errorLine.empty();
    }
  }
}

/** Quick-capture modal: single-line input with live token highlighting, a real parsed-preview
 * row, and an honest destination line. Desktop = centered card; mobile = bottom sheet + the
 * FAB in the Today view invokes it. See DESIGN section 3.4 / 5 / 6 / 7. */
export class CaptureModal extends CaptureModalBase {
  protected initialValue(): string {
    return "";
  }

  protected allowKeepOpen(): boolean {
    return true;
  }

  protected async persist(parsed: ParsedCapture, _raw: string): Promise<void> {
    if (!parsed.destination) throw new VtStaleError("taskline: no capture destination configured");
    const source = this.plugin.workspace.sourceById.get(parsed.destination.sourceId);
    if (!source) throw new VtStaleError(`taskline: source not found: ${parsed.destination.sourceId}`);
    const line = serializeCapturedTask(parsed, todayIso(new Date()));
    await appendUnderHeading(this.app, source.path, parsed.destination.heading, line);
  }
}

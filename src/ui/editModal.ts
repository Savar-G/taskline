import { App, setIcon } from "obsidian";
import type VaultTasksPlugin from "../main";
import { VtTask } from "../model";
import { relativeDateLabel, serializeTask } from "../format";
import { mergeEditDates, ParsedCapture, resolveEditDestination, taskToCaptureString } from "../captureRules";
import {
  calendarDates,
  EditablePriority,
  localIso,
  parseLocalIso,
  quickDates,
  setCaptureDate,
  setCapturePriority,
} from "../editProperties";
import { moveTaskLine, replaceTaskLine } from "../writer";
import { CaptureModalBase } from "./captureModal";

const PRIORITIES: Array<{ value: EditablePriority; label: string; detail: string }> = [
  { value: "p1", label: "Urgent", detail: "Priority 1" },
  { value: "p2", label: "High", detail: "Priority 2" },
  { value: "p3", label: "Medium", detail: "Priority 3" },
  { value: "p4", label: "Low", detail: "Priority 4" },
  { value: null, label: "None", detail: "No priority" },
];

const PRIORITY_LABEL: Record<string, string> = {
  p1: "Urgent",
  p2: "High",
  p3: "Medium",
  p4: "Low",
};

function menuDateLabel(iso: string): string {
  return parseLocalIso(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Edit modal: reuses the whole capture-grammar machinery (live highlight, preview row,
 * destination line) but seeds the input from the existing task and commits by REPLACING the
 * task's line in place - or MOVING its block if the area changed the destination file/heading.
 * Provenance, owner, stale flag, status char and any '📝' sub-bullets are preserved. Opened for
 * any open row. Sources with editPolicy "stay" are pinned to their own file + heading by
 * resolveEditDestination. Not opened for done/cancelled tasks
 * (the view withholds the affordance). See DESIGN §9. */
export class VtEditModal extends CaptureModalBase {
  private task: VtTask;
  private dateTrigger: HTMLButtonElement | null = null;
  private priorityTrigger: HTMLButtonElement | null = null;
  private dateValue: HTMLElement | null = null;
  private priorityValue: HTMLElement | null = null;
  private datePanel: HTMLElement | null = null;
  private priorityPanel: HTMLElement | null = null;
  private calendarWrap: HTMLElement | null = null;
  private calendarMonth = new Date();
  private selectedDate: string | undefined;
  private selectedPriority: EditablePriority = null;
  private dateButtons = new Map<string, HTMLButtonElement>();
  private priorityButtons: Array<{ value: EditablePriority; button: HTMLButtonElement }> = [];
  private controlId = `vt-edit-property-${Math.random().toString(36).slice(2)}`;

  constructor(app: App, plugin: VaultTasksPlugin, task: VtTask) {
    super(app, plugin);
    this.task = task;
  }

  onOpen(): void {
    super.onOpen();
    this.modalEl.addEventListener("keydown", this.onModalKeyDown);
  }

  onClose(): void {
    this.modalEl.removeEventListener("keydown", this.onModalKeyDown);
    super.onClose();
  }

  protected initialValue(): string {
    return taskToCaptureString(this.task);
  }

  protected placeholder(): string {
    return "Edit task…";
  }

  protected modalTitle(): string {
    return "Edit task";
  }

  protected usesExplicitActions(): boolean {
    return true;
  }

  protected wrapsInput(): boolean {
    return true;
  }

  protected destinationVerb(): string {
    return "saving";
  }

  protected buildSupplementalControls(parent: HTMLElement): void {
    const properties = parent.createDiv({ cls: "vt-edit-properties" });
    properties.setAttr("aria-label", "Task properties");
    const toolbar = properties.createDiv({ cls: "vt-edit-property-bar" });

    this.dateTrigger = this.buildPropertyTrigger(toolbar, "calendar-days", "Date");
    this.dateValue = this.dateTrigger.querySelector<HTMLElement>(".vt-edit-property-value");
    this.dateTrigger.setAttr("aria-controls", `${this.controlId}-date`);
    this.dateTrigger.addEventListener("click", () => this.togglePanel("date"));

    this.priorityTrigger = this.buildPropertyTrigger(toolbar, "flag", "Priority");
    this.priorityValue = this.priorityTrigger.querySelector<HTMLElement>(".vt-edit-property-value");
    this.priorityTrigger.setAttr("aria-controls", `${this.controlId}-priority`);
    this.priorityTrigger.addEventListener("click", () => this.togglePanel("priority"));

    this.datePanel = properties.createDiv({ cls: "vt-edit-property-panel vt-edit-property-panel--date" });
    this.datePanel.id = `${this.controlId}-date`;
    this.datePanel.setAttr("aria-label", "Choose a date");
    this.datePanel.hide();
    this.buildDatePanel(this.datePanel);

    this.priorityPanel = properties.createDiv({ cls: "vt-edit-property-panel vt-edit-property-panel--priority" });
    this.priorityPanel.id = `${this.controlId}-priority`;
    this.priorityPanel.setAttr("aria-label", "Choose a priority");
    this.priorityPanel.hide();
    this.buildPriorityPanel(this.priorityPanel);

    properties.addEventListener("keydown", (event) => this.onPropertyKeyDown(event));
  }

  protected onParsedChange(parsed: ParsedCapture): void {
    this.selectedDate = parsed.due ?? parsed.scheduled;
    this.selectedPriority = parsed.priority;

    if (this.dateValue) {
      this.dateValue.setText(this.selectedDate ? relativeDateLabel(this.selectedDate, new Date()) : "Set date");
    }
    if (this.priorityValue) {
      this.priorityValue.setText(this.selectedPriority ? PRIORITY_LABEL[this.selectedPriority] : "None");
    }
    this.dateButtons.forEach((button, iso) => {
      const selected = iso === this.selectedDate;
      button.toggleClass("vt-edit-menu-item--selected", selected);
      button.setAttr("aria-pressed", selected ? "true" : "false");
    });
    this.priorityButtons.forEach(({ value, button }) => {
      const selected = value === this.selectedPriority;
      button.toggleClass("vt-edit-menu-item--selected", selected);
      button.setAttr("aria-pressed", selected ? "true" : "false");
    });
  }

  protected renderDestination(parsed: ParsedCapture): void {
    const source = this.plugin.workspace.sourceById.get(this.task.sourceId);
    if (source?.editPolicy !== "stay") {
      super.renderDestination(parsed);
      return;
    }

    this.destLine.removeClass("vt-dest--inbox");
    const arrow = this.destLine.createSpan({ cls: "vt-dest-arrow", text: "→" });
    arrow.setAttr("aria-hidden", "true");
    this.destLine.createSpan({ cls: "vt-dest-label", text: `saving to ${source.label}` });
    this.destLine.createSpan({ cls: "vt-dest-sep", text: "›" });
    this.destLine.createSpan({ cls: "vt-dest-section", text: this.task.heading });
  }

  private buildPropertyTrigger(parent: HTMLElement, iconName: string, label: string): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "vt-edit-property-trigger" });
    button.type = "button";
    button.setAttr("aria-expanded", "false");
    const icon = button.createSpan({ cls: "vt-edit-property-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, iconName);
    const copy = button.createSpan({ cls: "vt-edit-property-copy" });
    copy.createSpan({ cls: "vt-edit-property-label", text: label });
    copy.createSpan({ cls: "vt-edit-property-value", text: label === "Date" ? "Set date" : "None" });
    const chevron = button.createSpan({ cls: "vt-edit-property-chevron", attr: { "aria-hidden": "true" } });
    setIcon(chevron, "chevron-down");
    return button;
  }

  private buildDatePanel(panel: HTMLElement): void {
    const shortcuts = panel.createDiv({ cls: "vt-edit-menu-list" });
    for (const option of quickDates(new Date())) {
      const button = this.buildMenuItem(shortcuts, option.label, menuDateLabel(option.iso), "calendar");
      button.addEventListener("click", () => this.applyDate(option.iso));
      this.dateButtons.set(option.iso, button);
    }

    const custom = this.buildMenuItem(shortcuts, "Choose date", "Open calendar", "ellipsis");
    custom.addEventListener("click", () => {
      const base = this.selectedDate ? parseLocalIso(this.selectedDate) : new Date();
      this.calendarMonth = new Date(base.getFullYear(), base.getMonth(), 1);
      this.renderCalendar();
      this.calendarWrap?.show();
      this.calendarWrap?.querySelector<HTMLButtonElement>('.vt-calendar-day[tabindex="0"]')?.focus();
    });

    const clear = this.buildMenuItem(shortcuts, "Clear date", "Remove date", "x");
    clear.addClass("vt-edit-menu-item--clear");
    clear.addEventListener("click", () => this.applyDate(null));

    this.calendarWrap = panel.createDiv({ cls: "vt-edit-calendar" });
    this.calendarWrap.hide();
  }

  private buildPriorityPanel(panel: HTMLElement): void {
    const list = panel.createDiv({ cls: "vt-edit-menu-list vt-edit-priority-list" });
    for (const option of PRIORITIES) {
      const button = this.buildMenuItem(list, option.label, option.detail, "flag");
      button.dataset.priority = option.value ?? "none";
      button.addEventListener("click", () => this.applyPriority(option.value));
      this.priorityButtons.push({ value: option.value, button });
    }
  }

  private buildMenuItem(parent: HTMLElement, label: string, detail: string, iconName: string): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "vt-edit-menu-item" });
    button.type = "button";
    const icon = button.createSpan({ cls: "vt-edit-menu-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, iconName);
    button.createSpan({ cls: "vt-edit-menu-label", text: label });
    button.createSpan({ cls: "vt-edit-menu-detail", text: detail });
    return button;
  }

  private togglePanel(kind: "date" | "priority"): void {
    const panel = kind === "date" ? this.datePanel : this.priorityPanel;
    const trigger = kind === "date" ? this.dateTrigger : this.priorityTrigger;
    const opening = panel?.style.display === "none";
    this.closePanels();
    if (!opening || !panel || !trigger) return;
    panel.show();
    trigger.setAttr("aria-expanded", "true");
    this.defer(() => panel.querySelector<HTMLButtonElement>("button")?.focus());
  }

  private closePanels(returnFocus?: HTMLButtonElement | null): void {
    this.datePanel?.hide();
    this.priorityPanel?.hide();
    this.calendarWrap?.hide();
    this.dateTrigger?.setAttr("aria-expanded", "false");
    this.priorityTrigger?.setAttr("aria-expanded", "false");
    returnFocus?.focus();
  }

  private applyDate(iso: string | null): void {
    this.replaceInputValue(setCaptureDate(this.inputValue(), iso, new Date(), this.plugin.workspace));
    this.closePanels(this.dateTrigger);
  }

  private applyPriority(priority: EditablePriority): void {
    this.replaceInputValue(setCapturePriority(this.inputValue(), priority, new Date(), this.plugin.workspace));
    this.closePanels(this.priorityTrigger);
  }

  private renderCalendar(): void {
    const wrap = this.calendarWrap;
    if (!wrap) return;
    wrap.empty();

    const header = wrap.createDiv({ cls: "vt-calendar-header" });
    const previous = header.createEl("button", { cls: "vt-calendar-nav" });
    previous.type = "button";
    previous.setAttr("aria-label", "Previous month");
    setIcon(previous, "chevron-left");
    const monthLabel = header.createSpan({
      cls: "vt-calendar-month",
      text: this.calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    });
    monthLabel.setAttr("aria-live", "polite");
    const next = header.createEl("button", { cls: "vt-calendar-nav" });
    next.type = "button";
    next.setAttr("aria-label", "Next month");
    setIcon(next, "chevron-right");
    previous.addEventListener("click", () => this.changeMonth(-1, "previous"));
    next.addEventListener("click", () => this.changeMonth(1, "next"));

    const weekdays = wrap.createDiv({ cls: "vt-calendar-weekdays", attr: { "aria-hidden": "true" } });
    for (const day of ["S", "M", "T", "W", "T", "F", "S"]) weekdays.createSpan({ text: day });

    const grid = wrap.createDiv({ cls: "vt-calendar-grid" });
    grid.setAttr("role", "group");
    grid.setAttr("aria-label", "Calendar dates");
    const dates = calendarDates(this.calendarMonth);
    const visible = new Set(dates.map(localIso));
    const today = localIso(new Date());
    const focusIso = this.selectedDate && visible.has(this.selectedDate)
      ? this.selectedDate
      : visible.has(today)
        ? today
        : localIso(new Date(this.calendarMonth.getFullYear(), this.calendarMonth.getMonth(), 1));
    for (const date of dates) {
      const iso = localIso(date);
      const button = grid.createEl("button", { cls: "vt-calendar-day", text: String(date.getDate()) });
      button.type = "button";
      button.dataset.date = iso;
      button.tabIndex = iso === focusIso ? 0 : -1;
      button.setAttr("aria-label", date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }));
      button.setAttr("aria-pressed", iso === this.selectedDate ? "true" : "false");
      if (date.getMonth() !== this.calendarMonth.getMonth()) button.addClass("vt-calendar-day--outside");
      if (iso === today) button.addClass("vt-calendar-day--today");
      if (iso === this.selectedDate) button.addClass("vt-calendar-day--selected");
      button.addEventListener("click", () => this.applyDate(iso));
    }
  }

  private changeMonth(delta: number, focus: "previous" | "next"): void {
    this.calendarMonth = new Date(this.calendarMonth.getFullYear(), this.calendarMonth.getMonth() + delta, 1);
    this.renderCalendar();
    const label = focus === "previous" ? "Previous month" : "Next month";
    this.calendarWrap?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.focus();
  }

  private onPropertyKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.classList.contains("vt-calendar-day")) {
      const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -7 : event.key === "ArrowDown" ? 7 : 0;
      if (delta === 0) return;
      event.preventDefault();
      const current = parseLocalIso(target.dataset.date ?? localIso(new Date()));
      current.setDate(current.getDate() + delta);
      const targetIso = localIso(current);
      let next = this.calendarWrap?.querySelector<HTMLButtonElement>(`.vt-calendar-day[data-date="${targetIso}"]`);
      if (!next) {
        this.calendarMonth = new Date(current.getFullYear(), current.getMonth(), 1);
        this.renderCalendar();
        next = this.calendarWrap?.querySelector<HTMLButtonElement>(`.vt-calendar-day[data-date="${targetIso}"]`);
      }
      this.calendarWrap?.querySelectorAll<HTMLButtonElement>(".vt-calendar-day").forEach((button) => {
        button.tabIndex = button === next ? 0 : -1;
      });
      next?.focus();
      return;
    }

    if (!target.classList.contains("vt-edit-menu-item")) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(target.parentElement?.querySelectorAll<HTMLButtonElement>(".vt-edit-menu-item") ?? []);
    const index = buttons.indexOf(target as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1);
    event.preventDefault();
    buttons[next]?.focus();
  }

  private onModalKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    const dateOpen = this.datePanel?.style.display !== "none";
    const priorityOpen = this.priorityPanel?.style.display !== "none";
    if (!dateOpen && !priorityOpen) return;
    event.preventDefault();
    event.stopPropagation();
    this.closePanels(dateOpen ? this.dateTrigger : this.priorityTrigger);
  };

  protected errorVerb(): string {
    return "Could not save";
  }

  protected async persist(parsed: ParsedCapture): Promise<void> {
    const dest = resolveEditDestination(this.task, parsed, this.plugin.workspace);
    const destSource = this.plugin.workspace.sourceById.get(dest.sourceId);
    if (!destSource) throw new Error(`Taskline source not found: ${dest.sourceId}`);

    const newLine = this.buildEditedLine(parsed, dest.sourceId);
    const moved = destSource.path !== this.task.filePath || dest.heading !== this.task.heading;

    if (moved) {
      await moveTaskLine(this.app, this.task, newLine, { file: destSource.path, heading: dest.heading });
    } else {
      await replaceTaskLine(this.app, this.task, newLine);
    }
  }

  /** Rebuilds the task line from the parse while preserving everything the capture grammar can't
   * express: existing provenance, owner, stale flag, status char, and done/cancelled dates.
   * The destination source identity is updated when an edit routes across sources. */
  private buildEditedLine(parsed: ParsedCapture, destSourceId: string): string {
    const dates = mergeEditDates(this.task, parsed);
    const edited: VtTask = {
      sourceId: destSourceId,
      filePath: this.task.filePath,
      lineNo: this.task.lineNo,
      rawLine: this.task.rawLine,
      indent: this.task.indent,
      status: this.task.status,
      statusChar: this.task.statusChar,
      title: parsed.title,
      tags: parsed.tags,
      priority: parsed.priority,
      due: dates.due,
      scheduled: dates.scheduled,
      recurrence: parsed.recurrence,
      provenance: this.task.provenance,
      owner: parsed.owner,
      stale: this.task.stale,
      doneDate: this.task.doneDate,
      cancelledDate: this.task.cancelledDate,
      heading: this.task.heading,
      subNotes: [],
    };
    return serializeTask(edited);
  }
}

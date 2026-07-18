import { ItemView, Menu, Notice, Platform, setIcon, WorkspaceLeaf } from "obsidian";
import type VaultTasksPlugin from "./main";
import { VtProposal, VtTask } from "./model";
import {
  completeTask,
  applyProposal,
  removeLine,
  setTaskStatus,
  VtRecurrenceUnavailableError,
} from "./writer";
import { taskArea } from "./query";
import { effectiveTaskIso } from "./query";
import { findProposalTarget } from "./proposals";
import { areaColor } from "./ui/areaColor";
import { buildTaskRow, TaskRowHandlers } from "./ui/taskRow";
import { buildProposedRow } from "./ui/proposedRow";
import {
  animateComplete,
  animateConfirm,
  animateReject,
  AnimToken,
  isCancellation,
  revertRow,
} from "./ui/motion";

export const VIEW_TYPE_TODAY = "vault-tasks-today";

export type VtTabId = "today" | "upcoming" | "all";

const WEEKDAY_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const TAB_TITLES: Record<VtTabId, string> = {
  today: "Today",
  upcoming: "Upcoming",
  all: "All Tasks",
};

const TAB_ICONS: Record<VtTabId, string> = {
  today: "calendar-days",
  upcoming: "calendar-range",
  all: "list-todo",
};

const PRIORITY_RANK: Record<string, number> = { p1: 0, p2: 1, p3: 2, p4: 3 };

function isOpen(t: VtTask): boolean {
  return t.status !== "done" && t.status !== "cancelled";
}

function localIso(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function faintDate(d: Date): string {
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

export class TodayView extends ItemView {
  private root!: HTMLElement;
  private unsub: (() => void) | null = null;
  private readyDisposer: (() => void) | null = null;
  private settingsDisposer: (() => void) | null = null;
  private debounceTimer: number | null = null;

  // Render coordination: while an optimistic animation is in flight we defer store-driven
  // re-renders so the animating row is not yanked out from under the motion.
  private animating = 0;
  private renderQueued = false;
  private closed = false;
  private animationTokens = new Set<AnimToken>();

  // In-flight completion guard: shared by every trigger path (ring click, Space/Enter,
  // status-menu Done) so a rapid second click during the ~680ms completion sequence can't
  // re-fire completeTask against the same row.
  private completingRows = new Set<HTMLElement>();

  // Roving tabindex state + per-row keyboard actions (rebuilt each render).
  private rows: HTMLElement[] = [];
  private activeRow = 0;
  private primaryAction: Map<HTMLElement, () => void> = new Map();
  private editAction: Map<HTMLElement, () => void> = new Map();
  private rejectAction: Map<HTMLElement, () => void> = new Map();

  private taskHandlers: TaskRowHandlers;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: VaultTasksPlugin
  ) {
    super(leaf);
    this.taskHandlers = {
      onComplete: (task, row) => this.onComplete(task, row),
      onStatusMenu: (task, ring, ev) => this.onStatusMenu(task, ring, ev),
      onEdit: (task) => this.plugin.openEdit(task),
    };
  }

  getViewType() {
    return VIEW_TYPE_TODAY;
  }

  getDisplayText() {
    return "Tasks";
  }

  getIcon() {
    return "check-circle";
  }

  async onOpen() {
    this.closed = false;
    this.root = this.containerEl.children[1] as HTMLElement;
    this.root.empty();
    this.root.addClass("vault-tasks-view");
    if (Platform.isMobile) {
      this.root.addClass("vt-mobile");
      this.containerEl.addClass("vt-mobile-host");
      this.buildFab();
    }
    this.root.addEventListener("keydown", this.onKeyDown);
    this.root.addEventListener("focusin", this.onFocusIn);
    this.settingsDisposer = this.plugin.onSettingsChange(() => this.bindStore());

    const store = this.plugin.store;
    if (store) {
      this.unsub = store.onChange(() => this.requestRender());
      this.renderNow();
    } else {
      this.renderLoading();
      this.readyDisposer = this.plugin.whenStoreReady(() => {
        const s = this.plugin.store;
        if (s) this.unsub = s.onChange(() => this.requestRender());
        this.renderNow();
      });
    }
  }

  async onClose() {
    this.closed = true;
    for (const token of this.animationTokens) token.cancelled = true;
    this.animationTokens.clear();
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.root?.removeEventListener("keydown", this.onKeyDown);
    this.root?.removeEventListener("focusin", this.onFocusIn);
    this.unsub?.();
    this.readyDisposer?.();
    this.unsub = null;
    this.readyDisposer = null;
    this.settingsDisposer?.();
    this.settingsDisposer = null;
    this.containerEl.querySelector(".vt-fab")?.remove();
    this.containerEl.removeClass("vt-mobile-host");
    this.containerEl.children[1].empty();
  }

  // ---- render coordination -------------------------------------------------

  private requestRender(): void {
    if (this.closed) return;
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      if (this.animating > 0) {
        this.renderQueued = true;
        return;
      }
      this.renderNow();
    }, 150);
  }

  private settle(): void {
    if (this.closed) return;
    if (this.animating > 0) this.animating--;
    if (this.animating === 0 && this.renderQueued) {
      this.renderQueued = false;
      this.renderNow();
    }
  }

  private renderLoading(): void {
    this.root.empty();
    this.root.createDiv({ cls: "vt-loading", text: "Loading tasks" });
  }

  private bindStore(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.plugin.store) this.unsub = this.plugin.store.onChange(() => this.requestRender());
    this.renderNow();
  }

  private renderNow(): void {
    if (this.closed) return;
    const store = this.plugin.store;
    this.root.empty();
    this.primaryAction.clear();
    this.editAction.clear();
    this.rejectAction.clear();
    if (!this.plugin.workspace.configured) {
      this.renderUnconfigured();
      return;
    }
    if (!store) {
      this.renderLoading();
      return;
    }

    const today = new Date();
    const tab = this.plugin.activeTab;

    this.buildHeader(today, tab);
    this.buildTabBar(tab);
    this.buildFilterPills(this.tabOpenTasks(store, today, tab));

    const sections = this.root.createDiv({ cls: "vt-sections" });
    if (tab === "today") this.renderTodayTab(sections, store, today);
    else if (tab === "upcoming") this.renderUpcomingTab(sections, store, today);
    else this.renderAllTab(sections, store, today);

    this.buildFooter();
    this.refreshRoving();
  }

  private sortTasks(tasks: VtTask[]): VtTask[] {
    return [...tasks].sort((a, b) => {
      const pr = (PRIORITY_RANK[a.priority ?? "p4"] ?? 3) - (PRIORITY_RANK[b.priority ?? "p4"] ?? 3);
      if (pr !== 0) return pr;
      const ad = effectiveTaskIso(a) ?? "";
      const bd = effectiveTaskIso(b) ?? "";
      return ad.localeCompare(bd);
    });
  }

  // ---- filtering -----------------------------------------------------------

  /** The pre-filter set of open tasks a tab draws its filter pills from. */
  private tabOpenTasks(store: NonNullable<VaultTasksPlugin["store"]>, today: Date, tab: VtTabId): VtTask[] {
    if (tab === "today") {
      return [...store.overdueTasks(today), ...store.dueToday(today), ...store.undatedOpenTasks()];
    }
    if (tab === "upcoming") {
      const days: VtTask[] = [];
      for (const g of store.upcomingByDay(today, 7)) days.push(...g.tasks);
      return [...days, ...store.laterTasks(today, 7)];
    }
    const grouped: VtTask[] = [];
    for (const g of store.allOpenGrouped()) grouped.push(...g.tasks);
    return [...grouped, ...store.inboxTasks()];
  }

  private passesFilter(task: VtTask): boolean {
    const filters = this.plugin.activeFilters;
    if (filters.size === 0) return true;
    const area = taskArea(task, this.plugin.workspace);
    if (area && filters.has(area)) return true;
    for (const tag of task.tags) if (filters.has(`tag:${tag}`)) return true;
    return false;
  }

  private filtered(tasks: VtTask[]): VtTask[] {
    return tasks.filter((t) => this.passesFilter(t));
  }

  private get filtersActive(): boolean {
    return this.plugin.activeFilters.size > 0;
  }

  // ---- header + tab bar + pills --------------------------------------------

  private buildHeader(today: Date, tab: VtTabId): void {
    const header = this.root.createDiv({ cls: "vt-header" });
    const titleBlock = header.createDiv({ cls: "vt-header-titles" });
    titleBlock.createEl("h1", { cls: "vt-title", text: TAB_TITLES[tab] });
    if (tab === "today") {
      const subtitle = `${WEEKDAY_LONG[today.getDay()]}, ${MONTH_SHORT[today.getMonth()]} ${today.getDate()}`;
      titleBlock.createDiv({ cls: "vt-subtitle", text: subtitle });
    }

    // Desktop capture affordance. On mobile the FAB (built once on the view root) stands in.
    if (!Platform.isMobile) {
      const add = header.createEl("button", { cls: "vt-header-add", text: "+" });
      add.setAttr("type", "button");
      add.setAttr("aria-label", "Add task");
      add.setAttr("title", "Add task");
      add.addEventListener("click", () => this.plugin.openCapture());
    }
  }

  private buildTabBar(tab: VtTabId): void {
    const bar = this.root.createDiv({ cls: "vt-tabs" });
    bar.setAttr("role", "tablist");
    bar.setAttr("aria-label", "Task views");
    const defs: Array<[VtTabId, string]> = [
      ["today", "Today"],
      ["upcoming", "Upcoming"],
      ["all", "All"],
    ];
    for (const [id, label] of defs) {
      const btn = bar.createEl("button", { cls: "vt-tab" });
      btn.setAttr("type", "button");
      btn.setAttr("role", "tab");
      btn.dataset.tab = id;
      const icon = btn.createSpan({ cls: "vt-tab-icon" });
      setIcon(icon, TAB_ICONS[id]);
      btn.createSpan({ cls: "vt-tab-label", text: label });
      const active = id === tab;
      btn.setAttr("aria-selected", active ? "true" : "false");
      btn.setAttr("tabindex", active ? "0" : "-1");
      if (active) btn.addClass("vt-tab--active");
      btn.addEventListener("click", () => this.switchTab(id));
    }
    bar.addEventListener("keydown", this.onTabKeydown);
  }

  private switchTab(id: VtTabId): void {
    if (this.plugin.activeTab === id) return;
    this.plugin.activeTab = id;
    this.renderNow();
  }

  private onTabKeydown = (ev: KeyboardEvent): void => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    const order: VtTabId[] = ["today", "upcoming", "all"];
    const idx = order.indexOf(this.plugin.activeTab);
    const next = ev.key === "ArrowRight"
      ? order[Math.min(order.length - 1, idx + 1)]
      : order[Math.max(0, idx - 1)];
    if (next !== this.plugin.activeTab) {
      this.switchTab(next);
      const btn = this.root.querySelector<HTMLElement>(`.vt-tab[data-tab="${next}"]`);
      btn?.focus();
    }
  };

  private buildFilterPills(openTasks: VtTask[]): void {
    const areaSet = new Set<string>();
    const tagSet = new Set<string>();
    for (const t of openTasks) {
      const a = taskArea(t, this.plugin.workspace);
      if (a) areaSet.add(a);
      for (const tag of t.tags) if (this.plugin.workspace.tagFilterByTag.has(tag)) tagSet.add(tag);
    }
    if (areaSet.size === 0 && tagSet.size === 0) return;

    const wrap = this.root.createDiv({ cls: "vt-filter-pills" });
    wrap.setAttr("role", "group");
    wrap.setAttr("aria-label", "Filter by area");

    for (const key of this.orderAreas([...areaSet])) {
      const label = this.plugin.workspace.areaById.get(key)?.label
        ?? this.plugin.workspace.groupById.get(key)?.label
        ?? key;
      this.buildPill(wrap, key, label);
    }
    for (const tag of tagSet) {
      const filter = this.plugin.workspace.tagFilterByTag.get(tag);
      this.buildPill(wrap, `tag:${tag}`, filter?.label ?? tag);
    }

    if (this.filtersActive) {
      const clear = wrap.createEl("button", { cls: "vt-filter-clear", text: "Clear" });
      clear.setAttr("type", "button");
      clear.addEventListener("click", () => {
        this.plugin.activeFilters.clear();
        this.renderNow();
      });
    }
  }

  private orderAreas(keys: string[]): string[] {
    const rank = (k: string): number => {
      return this.plugin.workspace.displayRank.get(k) ?? this.plugin.workspace.displayRank.size + 1;
    };
    return [...keys].sort((a, b) => {
      const r = rank(a) - rank(b);
      return r !== 0 ? r : a.localeCompare(b);
    });
  }

  private buildPill(wrap: HTMLElement, key: string, label: string): void {
    const pill = wrap.createEl("button", { cls: "vt-pill", text: label });
    pill.setAttr("type", "button");
    // Per-area accent: active pills tint their labels with the configured color.
    pill.style.setProperty("--vt-area-color", areaColor(key.replace(/^tag:/, ""), this.plugin.workspace));
    const active = this.plugin.activeFilters.has(key);
    pill.setAttr("aria-pressed", active ? "true" : "false");
    if (active) pill.addClass("vt-pill--active");
    pill.addEventListener("click", () => {
      const filters = this.plugin.activeFilters;
      if (filters.has(key)) filters.delete(key);
      else filters.add(key);
      this.renderNow();
    });
  }

  // ---- Today tab -----------------------------------------------------------

  private renderTodayTab(parent: HTMLElement, store: NonNullable<VaultTasksPlugin["store"]>, today: Date): void {
    const overdue = this.sortTasks(this.filtered(store.overdueTasks(today)));
    const todayTasks = this.sortTasks(this.filtered(store.dueToday(today)));
    const needsTriage = this.filtered(store.undatedOpenTasks());
    const proposals = store.getProposals();
    const openCount = store.getTasks().filter(isOpen).length;

    const empty = overdue.length === 0 && todayTasks.length === 0 && proposals.length === 0 && needsTriage.length === 0;
    if (empty) {
      if (this.filtersActive) this.buildFilterEmpty(parent);
      else this.buildEmptyState(parent, openCount);
      return;
    }

    if (overdue.length > 0) this.buildTaskSection(parent, "Overdue", overdue, today);
    if (todayTasks.length > 0) {
      this.buildTaskSection(parent, "Today", todayTasks, today);
    } else if (overdue.length > 0) {
      this.buildTodayEmptyWithOverdue(parent);
    }
    if (proposals.length > 0) this.buildProposedSection(parent, proposals);
    if (needsTriage.length > 0) this.buildNeedsTriage(parent, needsTriage.length);
  }

  // ---- Upcoming tab --------------------------------------------------------

  private renderUpcomingTab(parent: HTMLElement, store: NonNullable<VaultTasksPlugin["store"]>, today: Date): void {
    const days = store.upcomingByDay(today, 7);
    const later = this.sortTasks(this.filtered(store.laterTasks(today, 7)));

    let anyDay = false;
    for (let i = 0; i < days.length; i++) {
      const group = days[i];
      const tasks = this.sortTasks(this.filtered(group.tasks));
      if (tasks.length === 0) continue;
      anyDay = true;
      const label = i === 0 ? "Tomorrow" : WEEKDAY_LONG[group.date.getDay()];
      this.buildTaskSection(parent, label, tasks, today, { faint: faintDate(group.date) });
    }

    if (!anyDay && later.length === 0) {
      if (this.filtersActive) this.buildFilterEmpty(parent);
      else this.buildUpcomingEmpty(parent);
      return;
    }

    if (later.length > 0) {
      this.buildCollapsibleSection(parent, "later", "Later", later, today);
    }
  }

  // ---- All tab -------------------------------------------------------------

  private renderAllTab(parent: HTMLElement, store: NonNullable<VaultTasksPlugin["store"]>, today: Date): void {
    const groups = store.allOpenGrouped();
    const inbox = this.sortTasks(this.filtered(store.inboxTasks()));
    const completed = store.completedRecent(30);
    const completedVisible = this.filtered(completed.tasks);

    let anyVisible = false;

    for (const group of groups) {
      const tasks = this.filtered(group.tasks);
      if (tasks.length === 0) continue;
      anyVisible = true;
      if (group.mode === "by-heading") this.buildGroupedSourceSection(parent, group.label, tasks, today);
      else this.buildTaskSection(parent, group.label, this.sortTasks(tasks), today, { dot: areaColor(group.key, this.plugin.workspace) });
    }

    if (inbox.length > 0) {
      anyVisible = true;
      this.buildInboxSection(parent, inbox, today);
    }

    if (completedVisible.length > 0) {
      anyVisible = true;
      const note = completed.truncated ? "showing recent 30" : undefined;
      this.buildCollapsibleSection(parent, "completed", "Completed", completedVisible, today, {
        note,
        done: true,
      });
    }

    if (!anyVisible) {
      if (this.filtersActive) this.buildFilterEmpty(parent);
      else this.buildAllEmpty(parent);
    }
  }

  // ---- section builders ----------------------------------------------------

  /** Builds the mobile FAB once on the view container (survives list re-renders, which only
   * empty the inner scroll root). Accent-filled circle, bottom-right, safe-area aware. */
  private buildFab(): void {
    const fab = this.containerEl.createEl("button", { cls: "vt-fab" });
    fab.setAttr("type", "button");
    fab.setAttr("aria-label", "Add task");
    fab.createSpan({ cls: "vt-fab-plus", text: "+", attr: { "aria-hidden": "true" } });
    fab.addEventListener("click", () => this.plugin.openCapture());
  }

  private buildSectionHead(
    section: HTMLElement,
    label: string,
    count: number,
    opts?: { faint?: string; dot?: string }
  ): void {
    const head = section.createDiv({ cls: "vt-section-head" });
    // A small area-color dot precedes All-tab group labels only (Inbox/Completed/Today pass none).
    if (opts?.dot) {
      const dot = head.createSpan({ cls: "vt-group-dot", attr: { "aria-hidden": "true" } });
      dot.style.setProperty("--vt-area-color", opts.dot);
    }
    head.createSpan({ cls: "vt-section-label", text: label });
    head.createSpan({ cls: "vt-section-count", text: `· ${count}` });
    if (opts?.faint) head.createSpan({ cls: "vt-section-faint", text: opts.faint });
  }

  private buildTaskSection(
    parent: HTMLElement,
    label: string,
    tasks: VtTask[],
    today: Date,
    opts?: { faint?: string; dot?: string }
  ): void {
    const section = parent.createDiv({ cls: "vt-section" });
    this.buildSectionHead(section, label, tasks.length, { faint: opts?.faint, dot: opts?.dot });
    const list = section.createDiv({ cls: "vt-list" });
    list.setAttr("role", "list");
    for (const task of tasks) this.appendTaskRow(list, task, today);
  }

  /** A by-heading source group renders one group header with source headings as sub-labels. */
  private buildGroupedSourceSection(parent: HTMLElement, label: string, tasks: VtTask[], today: Date): void {
    const section = parent.createDiv({ cls: "vt-section" });
    this.buildSectionHead(section, label, tasks.length, { dot: areaColor(label, this.plugin.workspace) });

    const byHeading = new Map<string, VtTask[]>();
    for (const t of tasks) {
      const key = t.heading || "Other";
      if (!byHeading.has(key)) byHeading.set(key, []);
      byHeading.get(key)!.push(t);
    }
    for (const [heading, group] of byHeading) {
      section.createDiv({ cls: "vt-sublabel", text: heading });
      const list = section.createDiv({ cls: "vt-list" });
      list.setAttr("role", "list");
      for (const task of this.sortTasks(group)) this.appendTaskRow(list, task, today);
    }
  }

  /** Inbox captures: plain rows carrying a faint "unfiled" hint. Editing routes through the same
   * edit modal (the rows are fully editable); completing works. */
  private buildInboxSection(parent: HTMLElement, tasks: VtTask[], today: Date): void {
    const section = parent.createDiv({ cls: "vt-section" });
    this.buildSectionHead(section, "Inbox", tasks.length, { faint: "unfiled" });
    const list = section.createDiv({ cls: "vt-list" });
    list.setAttr("role", "list");
    for (const task of tasks) {
      const row = this.appendTaskRow(list, task, today);
      row.querySelector(".vt-row-meta")?.createSpan({ cls: "vt-unfiled-hint", text: "unfiled" });
    }
  }

  private buildCollapsibleSection(
    parent: HTMLElement,
    key: string,
    label: string,
    tasks: VtTask[],
    today: Date,
    opts?: { note?: string; done?: boolean }
  ): void {
    const expanded = this.plugin.expandedGroups.has(key);
    const section = parent.createDiv({ cls: "vt-section vt-section--collapsible" });

    const head = section.createEl("button", { cls: "vt-section-head vt-group-toggle" });
    head.setAttr("type", "button");
    head.setAttr("aria-expanded", expanded ? "true" : "false");
    const chevron = head.createSpan({ cls: "vt-chevron", text: "›" });
    chevron.setAttr("aria-hidden", "true");
    if (expanded) chevron.addClass("vt-chevron--open");
    head.createSpan({ cls: "vt-section-label vt-section-label--faint", text: label });
    head.createSpan({ cls: "vt-section-count", text: `· ${tasks.length}` });
    if (opts?.note) head.createSpan({ cls: "vt-section-faint", text: opts.note });
    head.addEventListener("click", () => {
      if (expanded) this.plugin.expandedGroups.delete(key);
      else this.plugin.expandedGroups.add(key);
      this.renderNow();
    });

    if (!expanded) return;
    const list = section.createDiv({ cls: "vt-list" });
    list.setAttr("role", "list");
    if (opts?.done) {
      for (const task of tasks) this.appendDoneRow(list, task, today);
    } else {
      for (const task of tasks) this.appendTaskRow(list, task, today);
    }
  }

  /** Live, interactive task row wired to completion. */
  private appendTaskRow(list: HTMLElement, task: VtTask, today: Date): HTMLElement {
    const row = buildTaskRow(list, task, today, this.taskHandlers, this.plugin.workspace);
    this.primaryAction.set(row, () => this.onComplete(task, row));
    this.editAction.set(row, () => this.plugin.openEdit(task));
    return row;
  }

  /** History row: rendered for visual continuity but non-interactive (no completion, no focus,
   * no edit). Done/cancelled tasks are history, not actions. */
  private appendDoneRow(list: HTMLElement, task: VtTask, today: Date): void {
    const row = buildTaskRow(list, task, today, this.taskHandlers, this.plugin.workspace);
    row.removeClass("vt-focusable");
    row.addClass("vt-row--done");
    row.removeAttribute("tabindex");
    const ring = row.querySelector<HTMLElement>(".vt-ring");
    if (ring) {
      ring.dataset.status = task.status;
      ring.removeAttribute("role");
      ring.setAttr("aria-hidden", "true");
    }
  }

  private buildTodayEmptyWithOverdue(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "vt-section" });
    this.buildSectionHead(section, "Today", 0);
    const empty = section.createDiv({ cls: "vt-section-empty" });
    empty.createDiv({ cls: "vt-empty-line1", text: "Nothing scheduled for today" });
    empty.createDiv({ cls: "vt-empty-line2", text: "You still have overdue items above." });
  }

  private buildProposedSection(parent: HTMLElement, proposals: VtProposal[]): void {
    const section = parent.createDiv({ cls: "vt-section vt-section--proposed" });
    this.buildSectionHead(section, "Proposed", proposals.length);
    const list = section.createDiv({ cls: "vt-list" });
    list.setAttr("role", "list");
    for (const proposal of proposals) {
      const row = buildProposedRow(list, proposal, {
        onConfirm: (p, r) => this.onConfirm(p, r),
        onReject: (p, r) => this.onReject(p, r),
      });
      this.primaryAction.set(row, () => this.onConfirm(proposal, row));
      this.rejectAction.set(row, () => this.onReject(proposal, row));
    }
  }

  /** A quiet backlog signal, not a second task list. Active filters are already
   * applied to the count and remain active when the user moves to All. */
  private buildNeedsTriage(parent: HTMLElement, count: number): void {
    const section = parent.createDiv({ cls: "vt-section vt-section--triage" });
    const button = section.createEl("button", { cls: "vt-triage-link" });
    button.setAttr("type", "button");
    button.setAttr(
      "aria-label",
      `View ${count} open undated ${count === 1 ? "task" : "tasks"} in All Tasks`
    );
    const icon = button.createSpan({ cls: "vt-triage-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, "list-filter");
    button.createSpan({ cls: "vt-triage-label", text: "Needs triage" });
    button.createSpan({ cls: "vt-section-count", text: `· ${count}` });
    button.createSpan({ cls: "vt-triage-hint", text: "Undated" });
    button.createSpan({ cls: "vt-triage-arrow", text: "›", attr: { "aria-hidden": "true" } });
    button.addEventListener("click", () => {
      this.switchTab("all");
      window.setTimeout(() => this.root.querySelector<HTMLElement>('.vt-tab[data-tab="all"]')?.focus(), 0);
    });
  }

  private buildEmptyState(parent: HTMLElement, openCount: number): void {
    const panel = parent.createDiv({ cls: "vt-empty-state" });
    panel.createDiv({ cls: "vt-empty-glyph", text: "○", attr: { "aria-hidden": "true" } });
    const firstRun = openCount === 0;
    panel.createDiv({
      cls: "vt-empty-title",
      text: firstRun ? "No tasks yet" : "Nothing due today",
    });
    panel.createDiv({
      cls: "vt-empty-sub",
      text: firstRun
        ? "Add your first with the command or the plus."
        : "Enjoy the quiet, or add something.",
    });
    const add = panel.createEl("button", { cls: "vt-empty-add", text: "Add task" });
    add.setAttr("type", "button");
    add.addEventListener("click", () => this.plugin.openCapture());
  }

  private renderUnconfigured(): void {
    this.root.empty();
    const panel = this.root.createDiv({ cls: "vt-empty-state" });
    panel.createDiv({ cls: "vt-empty-glyph", text: "○", attr: { "aria-hidden": "true" } });
    panel.createDiv({ cls: "vt-empty-title", text: "Set up Taskline" });
    panel.createDiv({ cls: "vt-empty-sub", text: "Choose the notes and headings Taskline should use. No files will be created." });
    const open = panel.createEl("button", { cls: "vt-empty-add", text: "Open settings" });
    open.type = "button";
    open.addEventListener("click", () => this.plugin.openSettings());
  }

  private buildUpcomingEmpty(parent: HTMLElement): void {
    const panel = parent.createDiv({ cls: "vt-empty-state" });
    panel.createDiv({ cls: "vt-empty-glyph", text: "○", attr: { "aria-hidden": "true" } });
    panel.createDiv({ cls: "vt-empty-title", text: "Nothing scheduled this week" });
    panel.createDiv({ cls: "vt-empty-sub", text: "The next 7 days are clear." });
  }

  private buildAllEmpty(parent: HTMLElement): void {
    const panel = parent.createDiv({ cls: "vt-empty-state" });
    panel.createDiv({ cls: "vt-empty-glyph", text: "○", attr: { "aria-hidden": "true" } });
    panel.createDiv({ cls: "vt-empty-title", text: "No tasks yet" });
    panel.createDiv({ cls: "vt-empty-sub", text: "Add something to get started." });
    const add = panel.createEl("button", { cls: "vt-empty-add", text: "Add task" });
    add.setAttr("type", "button");
    add.addEventListener("click", () => this.plugin.openCapture());
  }

  private buildFilterEmpty(parent: HTMLElement): void {
    const panel = parent.createDiv({ cls: "vt-empty-state" });
    panel.createDiv({ cls: "vt-empty-glyph", text: "○", attr: { "aria-hidden": "true" } });
    panel.createDiv({ cls: "vt-empty-title", text: "No tasks match" });
    panel.createDiv({ cls: "vt-empty-sub", text: "Clear the filters to see everything." });
    const clear = panel.createEl("button", { cls: "vt-empty-add", text: "Clear filters" });
    clear.setAttr("type", "button");
    clear.addEventListener("click", () => {
      this.plugin.activeFilters.clear();
      this.renderNow();
    });
  }

  private buildFooter(): void {
    const platform = Platform.isMobile ? "mobile" : "desktop";
    this.root.createDiv({
      cls: "vt-footer",
      text: `Taskline ${this.plugin.manifest.version} · ${platform}`,
    });
  }

  // ---- task actions --------------------------------------------------------

  private onComplete(task: VtTask, row: HTMLElement): void {
    if (this.completingRows.has(row)) return; // already in flight - ignore the re-fire
    this.completingRows.add(row);

    this.animating++;
    const token: AnimToken = { cancelled: false };
    this.animationTokens.add(token);

    animateComplete(row, token)
      .then(() => {
        this.animationTokens.delete(token);
        this.completingRows.delete(row);
        this.settle();
      })
      .catch((err) => {
        if (!isCancellation(err)) {
          console.error("taskline: completion animation failed", err);
          this.completingRows.delete(row);
          this.animationTokens.delete(token);
          this.settle();
        }
        // Cancellation is the write-failure path; the write catch handles revert + settle.
      });

    completeTask(this.plugin.app, task).catch((err) => {
      console.error("taskline: completeTask failed", err);
      token.cancelled = true;
      this.animationTokens.delete(token);
      revertRow(row);
      this.completingRows.delete(row);
      const message = err instanceof VtRecurrenceUnavailableError
        ? err.message
        : "Could not complete - the file changed. Try again.";
      new Notice(message);
      this.showRowNote(row, message);
      this.settle();
    });
  }

  private onStatusMenu(task: VtTask, ring: HTMLElement, ev: MouseEvent | TouchEvent): void {
    const menu = new Menu();
    const options: Array<[VtTask["status"], string, string]> = [
      ["todo", " ", "To do"],
      ["in-progress", "/", "In progress"],
      ["blocked", "!", "Blocked"],
      ["planning", "?", "Planning"],
    ];
    const annotation = `(↻ ${localIso(new Date())} from plugin)`;
    for (const [status, char, label] of options) {
      menu.addItem((item) => {
        item
          .setTitle(label)
          .setChecked(task.status === status)
          .onClick(() => {
            setTaskStatus(this.plugin.app, task, char, annotation).catch((err) => {
              console.error("taskline: setTaskStatus failed", err);
              new Notice("Could not update status - the file may have changed.");
            });
          });
      });
    }
    menu.addSeparator();
    // Edit is offered on every open row and withheld from history rows.
    if (isOpen(task)) {
      menu.addItem((item) => {
        item
          .setTitle("Edit")
          .setIcon("pencil")
          .onClick(() => this.plugin.openEdit(task));
      });
    }
    menu.addItem((item) => {
      item
        .setTitle("Done")
        .setIcon("check")
        .onClick(() => {
          const row = ring.closest<HTMLElement>(".vt-task-row");
          if (row) this.onComplete(task, row);
        });
    });
    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("Open source note")
        .setIcon("file")
        .onClick(() => this.onOpenSource(task));
    });
    if ("clientX" in ev && "clientY" in ev) {
      menu.showAtPosition({ x: ev.clientX, y: ev.clientY });
    } else {
      const rect = ring.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom });
    }
  }

  private onOpenSource(task: VtTask): void {
    void this.plugin.app.workspace.openLinkText(task.filePath, task.filePath, false);
  }

  // ---- proposal actions ----------------------------------------------------

  private locateForProposal(proposal: VtProposal): VtTask | null {
    const store = this.plugin.store;
    return store ? findProposalTarget(proposal, store.getTasks()) : null;
  }

  private onConfirm(proposal: VtProposal, row: HTMLElement): void {
    const match = this.locateForProposal(proposal);
    if (!match) {
      new Notice(
        "Could not locate the task for this proposal. Review the source note instead."
      );
      return;
    }

    // Write first, then play the ghost->solid transition, so a store-driven re-render never
    // yanks the row before the confirm animation runs (animating>0 defers it).
    this.animating++;
    applyProposal(this.plugin.app, proposal, match)
      .then(() => this.closed ? undefined : animateConfirm(row))
      .then(() => this.settle())
      .catch((err) => {
        console.error("taskline: confirm failed", err);
        this.showRowNote(row, "Could not confirm - the file changed. Try again.");
        this.settle();
      });
  }

  private onReject(proposal: VtProposal, row: HTMLElement): void {
    this.animating++;
    removeLine(this.plugin.app, proposal)
      .then(() => animateReject(row))
      .then(() => this.settle())
      .catch((err) => {
        console.error("taskline: reject failed", err);
        this.showRowNote(row, "Could not reject - the file changed. Try again.");
        this.settle();
      });
  }

  // ---- shared UI helpers ---------------------------------------------------

  private showRowNote(row: HTMLElement, message: string): void {
    row.querySelector(".vt-row-note")?.remove();
    row.createDiv({ cls: "vt-row-note", text: message });
  }

  // ---- keyboard / roving tabindex ------------------------------------------

  private refreshRoving(): void {
    this.rows = Array.from(this.root.querySelectorAll<HTMLElement>(".vt-focusable"));
    this.activeRow = 0;
    this.rows.forEach((r, i) => r.setAttribute("tabindex", i === 0 ? "0" : "-1"));
  }

  private onFocusIn = (e: FocusEvent): void => {
    const row = (e.target as HTMLElement)?.closest<HTMLElement>(".vt-focusable");
    if (!row) return;
    const idx = this.rows.indexOf(row);
    if (idx < 0) return;
    this.rows[this.activeRow]?.setAttribute("tabindex", "-1");
    this.activeRow = idx;
    row.setAttribute("tabindex", "0");
  };

  private moveRoving(dir: 1 | -1): void {
    if (this.rows.length === 0) return;
    this.rows[this.activeRow]?.setAttribute("tabindex", "-1");
    this.activeRow = Math.max(0, Math.min(this.rows.length - 1, this.activeRow + dir));
    const el = this.rows[this.activeRow];
    el.setAttribute("tabindex", "0");
    el.focus();
  }

  private onKeyDown = (ev: KeyboardEvent): void => {
    const active = this.root.ownerDocument.activeElement as HTMLElement | null;

    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      // Arrow roving is for the row list only; leave the tab bar / pills to their own handlers.
      if (active && (active.closest(".vt-tabs") || active.closest(".vt-filter-pills"))) return;
      if (this.rows.length === 0) return;
      ev.preventDefault();
      this.moveRoving(ev.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (!active || !active.classList.contains("vt-focusable")) return;
    const kind = active.dataset.kind;

    if (kind === "task") {
      if (ev.key === " ") {
        ev.preventDefault();
        this.primaryAction.get(active)?.();
      } else if (ev.key === "Enter" || ev.key === "e" || ev.key === "E") {
        ev.preventDefault();
        this.editAction.get(active)?.();
      }
      return;
    }

    if (kind === "proposal") {
      if (ev.key === "y" || ev.key === "Y" || ev.key === "Enter") {
        ev.preventDefault();
        this.primaryAction.get(active)?.();
      } else if (ev.key === "n" || ev.key === "N" || ev.key === "Backspace") {
        ev.preventDefault();
        this.rejectAction.get(active)?.();
      }
    }
  };
}

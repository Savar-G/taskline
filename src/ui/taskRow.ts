import { setIcon } from "obsidian";
import { VtTask } from "../model";
import { relativeDateLabel } from "../format";
import { areaColor } from "./areaColor";
import type { RuntimeWorkspace } from "../settings";
import { effectiveTaskIso } from "../query";
import { LongPressClickGuard } from "./longPress";

export interface TaskRowHandlers {
  onComplete(task: VtTask, row: HTMLElement): void;
  onStatusMenu(task: VtTask, ring: HTMLElement, ev: MouseEvent | TouchEvent): void;
  /** Opens the edit modal. Omitted in read-only contexts (capture preview). */
  onEdit?(task: VtTask): void;
}

/** A task is editable when it is open and an edit handler is wired. History rows show no pencil. */
function isEditable(task: VtTask, handlers: TaskRowHandlers): boolean {
  return (
    !!handlers.onEdit &&
    task.status !== "done" &&
    task.status !== "cancelled"
  );
}

function priorityToken(task: VtTask): "p1" | "p2" | "p3" | "p4" {
  return task.priority ?? "p4";
}

/** The temporal bucket of a task date relative to today. Drives the date-pill color per
 * DESIGN §3.2: overdue = red, today = green, tomorrow = orange, further out = muted. */
function dayBucket(iso: string, today: Date): "overdue" | "today" | "tomorrow" | "future" {
  const [y, m, d] = iso.split("T")[0].split("-").map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((dt.getTime() - todayMid.getTime()) / 86400000);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  return "future";
}

/** Builds the priority-ring checkbox. A hollow ring plus an SVG check that draws in on
 * completion. The ring is the completion control; the row is the roving-tabindex stop. */
function buildRing(parent: HTMLElement, task: VtTask): HTMLElement {
  const ring = parent.createDiv({ cls: "vt-ring" });
  ring.dataset.priority = priorityToken(task);
  ring.dataset.status = task.status;
  ring.setAttr("role", "checkbox");
  ring.setAttr("aria-checked", "false");
  ring.setAttr("aria-label", `Complete task: ${task.title}`);

  const svg = ring.createSvg("svg", {
    cls: "vt-check",
    attr: { viewBox: "0 0 24 24", "aria-hidden": "true" },
  });
  svg.createSvg("path", {
    attr: {
      d: "M5 12.5 L10 17.5 L19 6.5",
      fill: "none",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      pathLength: "1",
    },
  });
  return ring;
}

function buildDatePill(meta: HTMLElement, task: VtTask, today: Date): void {
  // Due is the default weight; scheduled-only renders fainter/italic. Never both raw emoji.
  const iso = effectiveTaskIso(task);
  const usingScheduled = !!iso && iso === task.scheduled && iso !== task.due;
  if (!iso) return;

  const pill = meta.createSpan({ cls: "vt-date-pill", text: relativeDateLabel(iso, today) });
  if (usingScheduled) pill.addClass("vt-date-pill--scheduled");
  const bucket = dayBucket(iso, today);
  if (bucket === "overdue") pill.addClass("vt-date-pill--overdue");
  else if (bucket === "today") pill.addClass("vt-date-pill--today");
  else if (bucket === "tomorrow") pill.addClass("vt-date-pill--tomorrow");
}

function buildAreaMetadata(meta: HTMLElement, task: VtTask, workspace: RuntimeWorkspace): void {
  const source = workspace.sourceById.get(task.sourceId);
  const group = source?.groupId ? workspace.groupById.get(source.groupId) : undefined;
  if (group?.ownerDisplay) {
    if (task.owner && !workspace.selfAliases.has(task.owner.trim().toLowerCase())) {
      const initials = task.owner
        .split(/[\s_]+/)
        .map((p) => p[0])
        .filter(Boolean)
        .slice(0, 2)
        .join("")
        .toUpperCase();
      const chip = meta.createSpan({ cls: "vt-owner-chip", text: initials });
      chip.setAttr("aria-label", `Owner ${task.owner}`);
    }
    return;
  }

  for (const area of task.tags) {
    const route = workspace.routeByTag.get(area);
    if (route && !route.showAsChip) continue;
    const chip = meta.createSpan({ cls: "vt-area-chip" });
    // The '#' glyph carries the area's full accent color (Todoist-style); the label stays muted.
    chip.style.setProperty("--vt-area-color", areaColor(area, workspace));
    chip.createSpan({ cls: "vt-area-hash", text: "#" });
    chip.createSpan({ cls: "vt-area-label", text: area });
  }
}

export function buildTaskRow(
  parent: HTMLElement,
  task: VtTask,
  today: Date,
  handlers: TaskRowHandlers,
  workspace: RuntimeWorkspace
): HTMLElement {
  const row = parent.createDiv({ cls: "vt-task-row vt-focusable" });
  row.dataset.kind = "task";
  row.setAttr("role", "listitem");

  const ring = buildRing(row, task);

  const main = row.createDiv({ cls: "vt-row-main" });

  if (task.status === "blocked") {
    main.createSpan({ cls: "vt-blocked-dot", attr: { "aria-hidden": "true" } });
  }

  const title = main.createSpan({ cls: "vt-task-title", text: task.title });
  if (task.status === "blocked" || task.status === "planning") {
    title.addClass("vt-task-title--muted");
  }

  const meta = row.createDiv({ cls: "vt-row-meta" });
  buildDatePill(meta, task, today);
  buildAreaMetadata(meta, task, workspace);

  if (task.recurrence) {
    const rec = meta.createSpan({ cls: "vt-recur", text: "↻" });
    rec.setAttr("aria-label", "Repeats");
    rec.setAttr("title", `Repeats ${task.recurrence}`);
  }

  if (task.stale) {
    const dot = meta.createSpan({ cls: "vt-stale-dot" });
    dot.dataset.level = task.stale.level;
    const tip = `Stale · ${task.stale.days}d`;
    dot.setAttr("aria-label", tip);
    dot.setAttr("title", tip);
  }

  const editable = isEditable(task, handlers);
  if (editable) {
    const edit = meta.createEl("button", { cls: "vt-edit-btn" });
    edit.setAttr("type", "button");
    edit.setAttr("aria-label", `Edit task: ${task.title}`);
    edit.setAttr("title", "Edit");
    setIcon(edit, "pencil");
    edit.addEventListener("click", (ev) => {
      ev.stopPropagation();
      handlers.onEdit?.(task);
    });
  }

  // Ring completes. The title zone opens edit on every platform, matching Todoist's split between
  // completion and task details without making users hunt for a hover-only control.
  const longPressGuard = new LongPressClickGuard();
  ring.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (longPressGuard.consumeClick()) {
      ev.preventDefault();
      return;
    }
    handlers.onComplete(task, row);
  });
  ring.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    handlers.onStatusMenu(task, ring, ev);
  });

  let longPress: number | null = null;
  ring.addEventListener("touchstart", (ev) => {
    longPress = window.setTimeout(() => {
      longPress = null;
      longPressGuard.fired();
      handlers.onStatusMenu(task, ring, ev);
    }, 500);
  }, { passive: true });
  const clearLongPress = () => {
    if (longPress !== null) {
      window.clearTimeout(longPress);
      longPress = null;
    }
  };
  ring.addEventListener("touchend", clearLongPress);
  ring.addEventListener("touchmove", clearLongPress);
  ring.addEventListener("touchcancel", clearLongPress);

  if (editable) {
    main.addClass("vt-row-main--editable");
    main.setAttr("title", "Edit task");
    main.addEventListener("click", (ev) => {
      ev.stopPropagation();
      handlers.onEdit?.(task);
    });
  }

  return row;
}

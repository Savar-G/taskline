import { VtTask } from "./model";
import type { RuntimeWorkspace, TaskSourceSetting } from "./settings";

export interface DayGroup {
  date: Date;
  tasks: VtTask[];
}

export interface AreaGroup {
  key: string;
  label: string;
  tasks: VtTask[];
  mode: "flat" | "by-heading";
  color?: string;
}

export interface CompletedResult {
  tasks: VtTask[];
  truncated: boolean;
}

function isOpen(t: VtTask): boolean {
  return t.status !== "done" && t.status !== "cancelled";
}

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isoToMid(iso: string): Date {
  const [y, m, d] = iso.split("T")[0].split("-").map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d);
}

export function effectiveTaskIso(t: VtTask): string | null {
  if (t.due && t.scheduled) return t.due < t.scheduled ? t.due : t.scheduled;
  return t.due ?? t.scheduled ?? null;
}

export function taskDate(t: VtTask): Date | null {
  const iso = effectiveTaskIso(t);
  return iso ? isoToMid(iso) : null;
}

export function isTaskToday(t: VtTask, today: Date): boolean {
  const date = taskDate(t);
  return !!date && dayDiff(today, date) === 0;
}

export function isTaskOverdue(t: VtTask, today: Date): boolean {
  const date = taskDate(t);
  return isOpen(t) && !!date && dayDiff(today, date) < 0;
}

function dayDiff(from: Date, to: Date): number {
  return Math.round((dateOnly(to).getTime() - dateOnly(from).getTime()) / 86400000);
}

function sourceFor(workspace: RuntimeWorkspace, task: VtTask): TaskSourceSetting | undefined {
  return workspace.sourceById.get(task.sourceId);
}

export function taskArea(t: VtTask, workspace: RuntimeWorkspace): string | null {
  const source = sourceFor(workspace, t);
  if (!source || source.role === "inbox") return null;
  if (source.groupId) return source.groupId;
  const configured = workspace.areasBySourceHeading.get(`${source.id}\u0000${t.heading.trim().toLowerCase()}`);
  return configured?.id ?? (t.heading || null);
}

export function upcomingByDay(tasks: VtTask[], today: Date, days = 7): DayGroup[] {
  const groups: DayGroup[] = [];
  for (let n = 1; n <= days; n++) {
    const day = dateOnly(today);
    day.setDate(day.getDate() + n);
    groups.push({ date: day, tasks: [] });
  }
  for (const t of tasks) {
    if (!isOpen(t)) continue;
    const d = taskDate(t);
    if (!d) continue;
    const diff = dayDiff(today, d);
    if (diff >= 1 && diff <= days) groups[diff - 1].tasks.push(t);
  }
  return groups;
}

export function laterTasks(tasks: VtTask[], today: Date, afterDays = 7): VtTask[] {
  return tasks.filter((t) => {
    if (!isOpen(t)) return false;
    const d = taskDate(t);
    return !!d && dayDiff(today, d) > afterDays;
  });
}

export function undatedOpenTasks(tasks: VtTask[]): VtTask[] {
  return tasks.filter((t) => isOpen(t) && !t.due && !t.scheduled);
}

export function allOpenGrouped(tasks: VtTask[], workspace: RuntimeWorkspace): AreaGroup[] {
  const groups: AreaGroup[] = [];
  const groupedSources = new Map<string, VtTask[]>();
  const headingGroups = new Map<string, { sourceId: string; heading: string; tasks: VtTask[] }>();

  for (const task of tasks) {
    if (!isOpen(task)) continue;
    const source = sourceFor(workspace, task);
    if (!source || source.role === "inbox") continue;
    if (source.groupId) {
      const groupTasks = groupedSources.get(source.groupId) ?? [];
      groupTasks.push(task);
      groupedSources.set(source.groupId, groupTasks);
      continue;
    }
    const heading = task.heading || source.label;
    const key = `${source.id}\u0000${heading}`;
    const entry = headingGroups.get(key) ?? { sourceId: source.id, heading, tasks: [] };
    entry.tasks.push(task);
    headingGroups.set(key, entry);
  }

  for (const entry of headingGroups.values()) {
    const area = workspace.areasBySourceHeading.get(`${entry.sourceId}\u0000${entry.heading.toLowerCase()}`);
    groups.push({
      key: area?.id ?? `${entry.sourceId}:${entry.heading}`,
      label: area?.label ?? entry.heading,
      tasks: entry.tasks,
      mode: "flat",
      color: area?.color,
    });
  }
  for (const [groupId, groupTasks] of groupedSources) {
    const group = workspace.groupById.get(groupId);
    if (!group) continue;
    groups.push({ key: group.id, label: group.label, tasks: groupTasks, mode: group.mode, color: group.color });
  }

  const unknownRank = workspace.displayRank.size + 1;
  return groups.sort((a, b) => {
    const rank = (key: string) => workspace.displayRank.get(key) ?? unknownRank;
    return rank(a.key) - rank(b.key) || a.label.localeCompare(b.label);
  });
}

export function inboxTasks(tasks: VtTask[], workspace: RuntimeWorkspace): VtTask[] {
  return tasks.filter((task) => sourceFor(workspace, task)?.role === "inbox" && isOpen(task));
}

function doneKey(t: VtTask): string {
  return t.doneDate ?? t.cancelledDate ?? "";
}

export function completedRecent(tasks: VtTask[], limit = 30): CompletedResult {
  const done = tasks
    .filter((t) => t.status === "done" || t.status === "cancelled")
    .sort((a, b) => doneKey(b).localeCompare(doneKey(a)));
  return { tasks: done.slice(0, limit), truncated: done.length > limit };
}

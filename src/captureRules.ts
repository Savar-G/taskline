// PURE module - no 'obsidian' import. Deterministic quick-add grammar for the capture bar.
// Everything here is a function of (input string, injected `today`) so it is fully
// unit-testable without a wall clock.

import type { VtTask } from "./model";
import { serializeTask } from "./format";
import type { RuntimeWorkspace } from "./settings";

export type CaptureTokenType = "date" | "scheduled" | "priority" | "area" | "recurrence" | "owner";

export interface CaptureToken {
  type: CaptureTokenType;
  start: number;
  end: number;
}

export interface CaptureDestination {
  sourceId: string;
  heading: string;
}

export interface ParsedCapture {
  title: string;
  priority: "p1" | "p2" | "p3" | "p4" | null;
  due?: string;
  scheduled?: string;
  recurrence?: string;
  owner?: string;
  tags: string[];
  destination: CaptureDestination | null;
  explicitRouteMatched: boolean;
  tokens: CaptureToken[];
}

export function knownCaptureTags(workspace: RuntimeWorkspace): string[] {
  const tags: string[] = [];
  for (const route of workspace.settings.captureRoutes) {
    if (!tags.includes(route.tag)) tags.push(route.tag);
    for (const alias of route.aliases) if (!tags.includes(alias)) tags.push(alias);
  }
  for (const filter of workspace.settings.tagFilters) if (!tags.includes(filter.tag)) tags.push(filter.tag);
  return tags;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  ["jan", "january"],
  ["feb", "february"],
  ["mar", "march"],
  ["apr", "april"],
  ["may"],
  ["jun", "june"],
  ["jul", "july"],
  ["aug", "august"],
  ["sep", "sept", "september"],
  ["oct", "october"],
  ["nov", "november"],
  ["dec", "december"],
];

function monthIndex(name: string): number {
  const n = name.toLowerCase();
  return MONTHS.findIndex((aliases) => aliases.includes(n));
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function flatten(arr: string[][]): string[] {
  const out: string[] = [];
  for (const inner of arr) out.push(...inner);
  return out;
}

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(base: Date, n: number): Date {
  const d = dateOnly(base);
  d.setDate(d.getDate() + n);
  return d;
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

interface DateMatch {
  start: number;
  end: number;
  connector: string | null;
  date: Date;
}

function findDateMatch(input: string, today: Date): DateMatch | null {
  const connector = "(?:(by|due|on|starting)\\s+)?";

  // Explicit ISO date. Edit reconstruction uses this lossless form so an overdue task never
  // rolls into next year merely because the user opened and saved it after its due date.
  {
    const re = new RegExp(`\\b${connector}(\\d{4})-(\\d{2})-(\\d{2})\\b`);
    const m = input.match(re);
    if (m && m.index !== undefined) {
      const year = parseInt(m[2], 10);
      const month = parseInt(m[3], 10) - 1;
      const day = parseInt(m[4], 10);
      const date = new Date(year, month, day);
      if (date.getFullYear() === year && date.getMonth() === month && date.getDate() === day) {
        return { start: m.index, end: m.index + m[0].length, connector: m[1] ?? null, date };
      }
    }
  }

  // 'in N days' / 'in N weeks'
  {
    const re = new RegExp(`\\b${connector}in\\s+(\\d+)\\s+(day|days|week|weeks)\\b`, "i");
    const m = input.match(re);
    if (m && m.index !== undefined) {
      const n = parseInt(m[2], 10);
      const isWeeks = /week/i.test(m[3]);
      return { start: m.index, end: m.index + m[0].length, connector: m[1] ?? null, date: addDays(today, isWeeks ? n * 7 : n) };
    }
  }

  // 'next week'
  {
    const re = new RegExp(`\\b${connector}next\\s+week\\b`, "i");
    const m = input.match(re);
    if (m && m.index !== undefined) {
      const todayDow = today.getDay();
      const daysUntil = (1 - todayDow + 7) % 7 || 7;
      return { start: m.index, end: m.index + m[0].length, connector: m[1] ?? null, date: addDays(today, daysUntil) };
    }
  }

  // 'next <weekday>'
  {
    const re = new RegExp(`\\b${connector}next\\s+(${WEEKDAYS.join("|")})\\b`, "i");
    const m = input.match(re);
    if (m && m.index !== undefined) {
      const targetDow = WEEKDAYS.indexOf(m[2].toLowerCase());
      const todayDow = today.getDay();
      const daysUntil = (targetDow - todayDow + 7) % 7 || 7;
      return { start: m.index, end: m.index + m[0].length, connector: m[1] ?? null, date: addDays(today, daysUntil) };
    }
  }

  // plain weekday (next occurrence, including today)
  {
    const re = new RegExp(`\\b${connector}(${WEEKDAYS.join("|")})\\b`, "i");
    const m = input.match(re);
    if (m && m.index !== undefined) {
      const targetDow = WEEKDAYS.indexOf(m[2].toLowerCase());
      const todayDow = today.getDay();
      const daysUntil = (targetDow - todayDow + 7) % 7;
      return { start: m.index, end: m.index + m[0].length, connector: m[1] ?? null, date: addDays(today, daysUntil) };
    }
  }

  // today / tomorrow / tonight
  {
    const re = new RegExp(`\\b${connector}(today|tomorrow|tonight)\\b`, "i");
    const m = input.match(re);
    if (m && m.index !== undefined) {
      const word = m[2].toLowerCase();
      const offset = word === "tomorrow" ? 1 : 0;
      return { start: m.index, end: m.index + m[0].length, connector: m[1] ?? null, date: addDays(today, offset) };
    }
  }

  // month day: 'Jul 4' / 'July 4'
  {
    const monthAlt = flatten(MONTHS).join("|");
    const re = new RegExp(`\\b${connector}(${monthAlt})\\s+(\\d{1,2})\\b`, "i");
    const m = input.match(re);
    if (m && m.index !== undefined) {
      const mi = monthIndex(m[2]);
      const day = parseInt(m[3], 10);
      let d = new Date(today.getFullYear(), mi, day);
      if (dateOnly(d) < dateOnly(today)) d = new Date(today.getFullYear() + 1, mi, day);
      return { start: m.index, end: m.index + m[0].length, connector: m[1] ?? null, date: d };
    }
  }

  // day month: '4 July'
  {
    const monthAlt = flatten(MONTHS).join("|");
    const re = new RegExp(`\\b${connector}(\\d{1,2})\\s+(${monthAlt})\\b`, "i");
    const m = input.match(re);
    if (m && m.index !== undefined) {
      const mi = monthIndex(m[3]);
      const day = parseInt(m[2], 10);
      let d = new Date(today.getFullYear(), mi, day);
      if (dateOnly(d) < dateOnly(today)) d = new Date(today.getFullYear() + 1, mi, day);
      return { start: m.index, end: m.index + m[0].length, connector: m[1] ?? null, date: d };
    }
  }

  // numeric M/D
  {
    const re = new RegExp(`\\b${connector}(\\d{1,2})\\/(\\d{1,2})\\b`);
    const m = input.match(re);
    if (m && m.index !== undefined) {
      const mi = parseInt(m[2], 10) - 1;
      const day = parseInt(m[3], 10);
      let d = new Date(today.getFullYear(), mi, day);
      if (dateOnly(d) < dateOnly(today)) d = new Date(today.getFullYear() + 1, mi, day);
      return { start: m.index, end: m.index + m[0].length, connector: m[1] ?? null, date: d };
    }
  }

  return null;
}

function blank(masked: string, start: number, end: number): string {
  return masked.slice(0, start) + " ".repeat(end - start) + masked.slice(end);
}

interface ProtectedTitle {
  value: string;
  end: number;
}

/** Edit strings begin with a JSON string literal. That creates a real syntax boundary around the
 * title, so words such as "Monday", "due Aug 21", "daily", or "#school" cannot be consumed as
 * metadata merely because an unchanged task was opened and saved. */
function parseProtectedTitle(input: string): ProtectedTitle | null {
  if (!input.startsWith('"')) return null;

  let escaped = false;
  for (let i = 1; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char !== '"') continue;
    if (i + 1 < input.length && !/\s/.test(input[i + 1])) return null;
    try {
      const value = JSON.parse(input.slice(0, i + 1));
      return typeof value === "string" ? { value, end: i + 1 } : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function parseCapture(input: string, today: Date, workspace: RuntimeWorkspace): ParsedCapture {
  const tokens: CaptureToken[] = [];
  const removeSpans: Array<{ start: number; end: number }> = [];
  // `masked` tracks already-consumed spans (blanked to same-length whitespace) so later
  // passes never re-match characters a prior pass already claimed (e.g. the 'Sunday' inside
  // an already-consumed 'every Sunday' recurrence phrase must not also parse as a weekday).
  const protectedTitle = parseProtectedTitle(input);
  let masked = protectedTitle ? blank(input, 0, protectedTitle.end) : input;

  let priority: "p1" | "p2" | "p3" | "p4" | null = null;
  {
    const named = masked.match(/(?:^|\s)priority:(urgent|high|medium|low)(?=\s|$)/i);
    if (named && named.index !== undefined) {
      const level = named[1].toLowerCase();
      priority = level === "urgent" ? "p1" : level === "high" ? "p2" : level === "medium" ? "p3" : "p4";
      const leadingSpace = named[0].match(/^\s*/)?.[0].length ?? 0;
      const start = named.index + leadingSpace;
      const end = named.index + named[0].length;
      tokens.push({ type: "priority", start, end });
      removeSpans.push({ start, end });
      masked = blank(masked, start, end);
    } else {
      const m = masked.match(/(?:^|\s)(!{1,3})(?=\s|$)/);
      if (m && m.index !== undefined) {
        const bangs = m[1];
        priority = bangs.length === 3 ? "p1" : bangs.length === 2 ? "p2" : "p3";
        const start = m.index + (m[0].length - bangs.length);
        const end = start + bangs.length;
        tokens.push({ type: "priority", start, end });
        removeSpans.push({ start, end });
        masked = blank(masked, start, end);
      }
    }
  }

  let recurrence: string | undefined;
  {
    // Stop at #/!/@ and at date connectors (by/due/starting) so 'every Sunday by Jul 5'
    // keeps 'by Jul 5' available for the date pass. 'on' stays inside the phrase
    // ('every week on Sunday' is one recurrence).
    const re = /\bevery\s+[^#!@]+?(?=\s*(?:#|!|@|\b(?:by|due|starting)\b|$))/i;
    const m = masked.match(re);
    if (m && m.index !== undefined) {
      recurrence = m[0].trim();
      const start = m.index;
      const end = m.index + m[0].length;
      tokens.push({ type: "recurrence", start, end });
      removeSpans.push({ start, end });
      masked = blank(masked, start, end);
    } else {
      const dailyM = masked.match(/\bdaily\b/i);
      const weeklyM = masked.match(/\bweekly\b/i);
      if (dailyM && dailyM.index !== undefined) {
        recurrence = "every day";
        tokens.push({ type: "recurrence", start: dailyM.index, end: dailyM.index + dailyM[0].length });
        removeSpans.push({ start: dailyM.index, end: dailyM.index + dailyM[0].length });
        masked = blank(masked, dailyM.index, dailyM.index + dailyM[0].length);
      } else if (weeklyM && weeklyM.index !== undefined) {
        recurrence = "every week";
        tokens.push({ type: "recurrence", start: weeklyM.index, end: weeklyM.index + weeklyM[0].length });
        removeSpans.push({ start: weeklyM.index, end: weeklyM.index + weeklyM[0].length });
        masked = blank(masked, weeklyM.index, weeklyM.index + weeklyM[0].length);
      }
    }
  }

  let due: string | undefined;
  let scheduled: string | undefined;
  {
    const dm = findDateMatch(masked, today);
    if (dm) {
      const end = dm.end;
      const dateStr = fmtDate(dm.date);
      const isScheduled = dm.connector?.toLowerCase() === "starting";
      if (isScheduled) scheduled = dateStr;
      else due = dateStr;
      tokens.push({ type: isScheduled ? "scheduled" : "date", start: dm.start, end });
      removeSpans.push({ start: dm.start, end });
      masked = blank(masked, dm.start, end);
    }
  }

  // Recurrence needs an anchor date for the Tasks plugin to spawn the next occurrence
  // (same rule as the vault filing skill): default to due today when none was given.
  if (recurrence && !due && !scheduled) {
    due = fmtDate(today);
  }

  const tags: string[] = [];
  let destination: CaptureDestination | null = null;
  let explicitRouteMatched = false;
  {
    const re = /#([\w/-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked))) {
      const tag = m[1].toLowerCase();
      tags.push(tag);
      tokens.push({ type: "area", start: m.index, end: m.index + m[0].length });
      removeSpans.push({ start: m.index, end: m.index + m[0].length });
      if (!destination) {
        const route = workspace.routeByTag.get(tag);
        if (route) {
          destination = route.destination;
          explicitRouteMatched = true;
        }
      }
    }
    masked = masked.replace(/#([\w/-]+)/g, (whole) => " ".repeat(whole.length));
  }

  let owner: string | undefined;
  {
    const re = /@([\w.-]+)/g;
    const m = re.exec(masked);
    if (m) {
      owner = m[1];
      tokens.push({ type: "owner", start: m.index, end: m.index + m[0].length });
      removeSpans.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  let title: string;
  if (protectedTitle) {
    title = protectedTitle.value;
  } else {
    removeSpans.sort((a, b) => b.start - a.start);
    title = input;
    for (const span of removeSpans) {
      title = title.slice(0, span.start) + title.slice(span.end);
    }
    title = title.replace(/\s+/g, " ").trim();
  }

  tokens.sort((a, b) => a.start - b.start);

  return {
    title,
    priority,
    due,
    scheduled,
    recurrence,
    owner,
    tags,
    destination: destination ?? workspace.settings.fallbackCaptureDestination,
    explicitRouteMatched,
    tokens,
  };
}

/** PURE inverse of parseCapture, good enough to seed the edit modal: rebuilds a capture-grammar
 * string from a task so `parseCapture(taskToCaptureString(t))` reproduces the task's title,
 * areas, priority, due, scheduled and recurrence.
 *
 * A task carrying both dates represents the due date in the grammar; the edit writer merges the
 * untouched scheduled date back before serialization. The title is emitted as a JSON string literal,
 * creating a protected parse boundary; dates use explicit ISO phrases so overdue tasks cannot
 * roll into the next year. */
export function taskToCaptureString(task: VtTask): string {
  const parts: string[] = [];
  parts.push(JSON.stringify(task.title));
  for (const tag of task.tags) parts.push(`#${tag}`);
  if (task.owner) parts.push(`@${task.owner}`);

  if (task.recurrence) {
    const rec = task.recurrence.trim();
    parts.push(rec.startsWith("every") ? rec : `every ${rec}`);
  }

  const datePhrase = (iso: string, connector: string): string => {
    return `${connector} ${iso.split("T")[0]}`;
  };
  if (task.due) parts.push(datePhrase(task.due, "by"));
  else if (task.scheduled) parts.push(datePhrase(task.scheduled, "starting"));

  if (task.priority === "p1") parts.push("!!!");
  else if (task.priority === "p2") parts.push("!!");
  else if (task.priority === "p3") parts.push("!");
  else if (task.priority === "p4") parts.push("priority:low");

  return parts.join(" ");
}

/** Resolves an edited task's destination. Stay-policy sources remain pinned to their current
 * source and heading; route-policy sources follow capture routing. */
export function resolveEditDestination(
  task: VtTask,
  parsed: ParsedCapture,
  workspace: RuntimeWorkspace
): CaptureDestination {
  const source = workspace.sourceById.get(task.sourceId);
  if (!source || source.editPolicy === "stay") {
    return { sourceId: task.sourceId, heading: task.heading };
  }
  return parsed.explicitRouteMatched && parsed.destination
    ? parsed.destination
    : { sourceId: task.sourceId, heading: task.heading };
}

/** The capture grammar intentionally represents one date. Preserve the original task's other
 * date during edits so changing or leaving the represented date cannot erase information. */
export function mergeEditDates(task: VtTask, parsed: ParsedCapture): Pick<VtTask, "due" | "scheduled"> {
  if (task.due && task.scheduled) {
    return { due: parsed.due, scheduled: parsed.scheduled ?? task.scheduled };
  }
  return { due: parsed.due, scheduled: parsed.scheduled };
}

/** Serializes exactly the metadata represented by the capture preview. All source roles use this
 * path; an inbox is a destination, not a request to persist the user's raw grammar. */
export function serializeCapturedTask(parsed: ParsedCapture, capturedOn: string): string {
  return serializeTask({
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
    provenance: { kind: "inbox", date: capturedOn },
    heading: "",
    subNotes: [],
  });
}

// ---- deterministic keyword -> area suggestion (DESIGN §9.6) -----------------

export interface AreaSuggestion {
  tag: string;
  matchedWord: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Deterministic, confirm-to-apply area suggestion for an untagged capture. Word-boundary,
 * case-insensitive matching against AREA_SUGGESTION_TABLE; the first alias hit (table order,
 * then word order within the row) wins. Never suggests once the input already carries any
 * '#area' tag - the user has already made an explicit routing choice, so a keyword guess would
 * be noise, not help. Pure and side-effect free: the caller (capture modal) decides whether and
 * how to surface it, and nothing here ever auto-applies a tag. */
export function suggestArea(input: string, workspace: RuntimeWorkspace): AreaSuggestion | null {
  if (/#([\w/-]+)/.test(input)) return null;

  for (const entry of workspace.settings.captureRoutes) {
    for (const word of entry.keywords) {
      const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i");
      const m = input.match(re);
      if (m) return { tag: entry.tag, matchedWord: m[0] };
    }
  }
  return null;
}

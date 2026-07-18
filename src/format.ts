// PURE module - no 'obsidian' import. The single write-formatter: every serializer in the
// plugin funnels through here so the Tasks-plugin trailing-signifier-run invariant is
// enforced in exactly one place.
//
// INVARIANT (has bitten this system twice): the Tasks plugin parses signifiers backwards
// from line-end, so all signifier emoji must form one contiguous run at the END of the
// line; annotation text ((from ...), owner, stale flags) must sit BEFORE that run.

import { VtProvenance, VtStale, VtTask } from "./model";

const PRIORITY_TO_EMOJI: Record<string, string> = {
  p1: "🔺",
  p2: "⏫",
  p3: "🔼",
  p4: "🔽",
};

function provenanceToText(p: VtProvenance): string {
  switch (p.kind) {
    case "inbox":
      return `(from inbox ${p.date})`;
    case "link":
      return `(from ${p.source})`;
    case "reconciled":
      return `(reconciled from ${p.source})`;
    case "added-by-reconcile":
      return `(added by reconcile ${p.date} from ${p.source})`;
    default:
      return "";
  }
}

function staleToText(s: VtStale): string {
  return s.level === "alert" ? `🔴 stale ${s.days}d (escalate)` : `🟡 stale ${s.days}d`;
}

/** Serializes a VtTask back into a single Tasks-plugin-compliant line. */
export function serializeTask(task: VtTask): string {
  const bodyParts: string[] = [];
  if (task.title) bodyParts.push(task.title);
  for (const tag of task.tags) bodyParts.push(`#${tag}`);
  if (task.provenance) {
    const text = provenanceToText(task.provenance);
    if (text) bodyParts.push(text);
  }
  if (task.owner) bodyParts.push(`— @${task.owner}`);
  if (task.stale) bodyParts.push(staleToText(task.stale));

  // Taskline is date-only. Parsing and writing deliberately use Tasks-compatible YYYY-MM-DD.
  const signifiers: string[] = [];
  if (task.priority) signifiers.push(PRIORITY_TO_EMOJI[task.priority]);
  if (task.recurrence) signifiers.push(`🔁 ${task.recurrence}`);
  if (task.scheduled) signifiers.push(`⏳ ${task.scheduled.split("T")[0]}`);
  if (task.due) signifiers.push(`📅 ${task.due.split("T")[0]}`);
  if (task.doneDate) signifiers.push(`✅ ${task.doneDate}`);
  if (task.cancelledDate) signifiers.push(`❌ ${task.cancelledDate}`);

  const body = [bodyParts.join(" "), signifiers.join(" ")].filter(Boolean).join(" ");
  return `${task.indent ?? ""}- [${task.statusChar}] ${body}`.replace(/\s+$/, "");
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function parseIsoDate(iso: string): Date {
  const [datePart] = iso.split("T");
  const [y, m, d] = datePart.split("-").map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d);
}

/** PURE. Human-facing calendar-relative label for a task date, per DESIGN §3.2:
 * Today / Tomorrow / Yesterday / short weekday within a week / else "Mon D".
 * Any legacy time component is ignored because Taskline storage is date-only. */
export function relativeDateLabel(iso: string, today: Date): string {
  const date = parseIsoDate(iso);
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diffDays = Math.round((date.getTime() - todayMid.getTime()) / 86400000);

  let label: string;
  if (diffDays === 0) label = "Today";
  else if (diffDays === 1) label = "Tomorrow";
  else if (diffDays === -1) label = "Yesterday";
  else if (diffDays > 1 && diffDays < 7) label = WEEKDAY_SHORT[date.getDay()];
  else {
    label = `${MONTH_SHORT[date.getMonth()]} ${date.getDate()}`;
    if (date.getFullYear() !== todayMid.getFullYear()) label += `, ${date.getFullYear()}`;
  }

  return label;
}

/** Replaces the checkbox status char in a raw task line, e.g. ' ' -> 'x'. Tolerant: returns
 * the line unchanged if it doesn't look like a checkbox line. */
export function setStatusChar(rawLine: string, char: string): string {
  return rawLine.replace(/^(\s*-\s*\[)(.)(\])/, (_whole, a: string, _b: string, c: string) => `${a}${char}${c}`);
}

const SIGNIFIER_TOKEN =
  "🔺|⏫|🔼|🔽" +
  "|🔁\\s*[^🔺⏫🔼🔽📅⏳✅❌]*" +
  "|⏳\\s*\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2})?" +
  "|📅\\s*\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2})?" +
  "|✅\\s*\\d{4}-\\d{2}-\\d{2}" +
  "|❌\\s*\\d{4}-\\d{2}-\\d{2}";

const TRAILING_RUN_RE = new RegExp(`(?:\\s*(?:${SIGNIFIER_TOKEN}))+$`);

/** Inserts annotation text immediately before the trailing signifier run (or at the end of
 * the line if there is no such run), preserving the invariant. */
export function insertAnnotation(rawLine: string, text: string): string {
  const m = rawLine.match(TRAILING_RUN_RE);
  if (!m || m.index === undefined) {
    return `${rawLine.replace(/\s+$/, "")} ${text}`;
  }
  const before = rawLine.slice(0, m.index).replace(/\s+$/, "");
  const after = m[0];
  return `${before} ${text}${after}`;
}

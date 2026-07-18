// PURE module - no 'obsidian' import. Parses Tasks-plugin emoji-format lines out of the
// configured task sources. Tolerant of malformed input: never throws, returns null
// instead when a line doesn't look like a task/proposal.

import {
  VtProvenance,
  VtProposal,
  VtStale,
  VtTask,
  statusCharToStatus,
} from "./model";
import type { RuntimeWorkspace, TaskSourceSetting } from "./settings";

export interface ParseCtx {
  sourceId: string;
  filePath: string;
  lineNo: number;
  heading: string;
}

const PRIORITY_EMOJI: Record<string, "p1" | "p2" | "p3" | "p4"> = {
  "🔺": "p1",
  "⏫": "p2",
  "🔼": "p3",
  "🔽": "p4",
};

const SIGNIFIER_CLASS = "🔺⏫🔼🔽📅⏳✅❌";

function parseProvenanceText(text: string): VtProvenance {
  let m: RegExpMatchArray | null;
  if ((m = text.match(/^added by reconcile (\S+) from (.+)$/))) {
    return { kind: "added-by-reconcile", date: m[1], source: m[2].trim() };
  }
  if ((m = text.match(/^reconciled from (.+)$/))) {
    return { kind: "reconciled", source: m[1].trim() };
  }
  if ((m = text.match(/^from inbox (\d{4}-\d{2}-\d{2})$/))) {
    return { kind: "inbox", date: m[1] };
  }
  if ((m = text.match(/^from (.+)$/))) {
    return { kind: "link", source: m[1].trim() };
  }
  return { kind: "unknown" };
}

export function parseTaskLine(line: string, ctx: ParseCtx): VtTask | null {
  if (typeof line !== "string") return null;
  const m = line.match(/^(\s*)-\s*\[(.)\]\s?(.*)$/);
  if (!m) return null;

  const statusChar = m[2];
  let work = m[3] ?? "";

  // priority
  let priority: VtTask["priority"] = null;
  const prMatch = work.match(/🔺|⏫|🔼|🔽/);
  if (prMatch) {
    priority = PRIORITY_EMOJI[prMatch[0]];
    work = work.replace(prMatch[0], "");
  }

  // done date
  let doneDate: string | undefined;
  const doneMatch = work.match(/✅\s*(\d{4}-\d{2}-\d{2})/);
  if (doneMatch) {
    doneDate = doneMatch[1];
    work = work.replace(doneMatch[0], "");
  }

  // cancelled date
  let cancelledDate: string | undefined;
  const cancelMatch = work.match(/❌\s*(\d{4}-\d{2}-\d{2})/);
  if (cancelMatch) {
    cancelledDate = cancelMatch[1];
    work = work.replace(cancelMatch[0], "");
  }

  // scheduled
  let scheduled: string | undefined;
  const schedMatch = work.match(/⏳\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)/);
  if (schedMatch) {
    scheduled = schedMatch[1].split("T")[0];
    work = work.replace(schedMatch[0], "");
  }

  // due
  let due: string | undefined;
  const dueMatch = work.match(/📅\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)/);
  if (dueMatch) {
    due = dueMatch[1].split("T")[0];
    work = work.replace(dueMatch[0], "");
  }

  // recurrence - everything after 🔁 up to the next signifier emoji or end of string
  let recurrence: string | undefined;
  const recRe = new RegExp(`🔁\\s*([^${SIGNIFIER_CLASS}]*)`);
  const recMatch = work.match(recRe);
  if (recMatch) {
    recurrence = recMatch[1].trim();
    work = work.replace(recMatch[0], "");
  }

  // stale flag
  let stale: VtStale | undefined;
  const staleMatch = work.match(/(🟡|🔴)\s*stale\s*(\d+)d(\s*\(escalate\))?/);
  if (staleMatch) {
    stale = { level: staleMatch[1] === "🔴" ? "alert" : "warn", days: parseInt(staleMatch[2], 10) };
    work = work.replace(staleMatch[0], "");
  }

  // owner - '— @Name'
  let owner: string | undefined;
  const ownerMatch = work.match(/—\s*@([\w.-]+)/);
  if (ownerMatch) {
    owner = ownerMatch[1];
    work = work.replace(ownerMatch[0], "");
  }

  // provenance - scan top-level paren groups; first "from"/"reconciled from"/"added by
  // reconcile" group found is kept, all matching groups are stripped from the title.
  let provenance: VtProvenance | undefined;
  work = work.replace(/\(([^()]*)\)/g, (whole, inner: string) => {
    const trimmed = inner.trim();
    if (/^(from|reconciled from|added by reconcile)\b/.test(trimmed)) {
      if (!provenance) provenance = parseProvenanceText(trimmed);
      return "";
    }
    return whole;
  });

  // tags
  const tags: string[] = [];
  work = work.replace(/#([\w/-]+)/g, (_whole, tag: string) => {
    tags.push(tag.toLowerCase());
    return "";
  });

  const title = work.replace(/\s+/g, " ").trim();

  return {
    sourceId: ctx.sourceId,
    filePath: ctx.filePath,
    lineNo: ctx.lineNo,
    rawLine: line,
    indent: m[1],
    status: statusCharToStatus(statusChar),
    statusChar,
    title,
    tags,
    priority,
    due,
    scheduled,
    doneDate,
    cancelledDate,
    recurrence,
    provenance,
    owner,
    stale,
    heading: ctx.heading,
    subNotes: [],
  };
}

export function parseProposalLine(line: string, ctx: ParseCtx): VtProposal | null {
  if (typeof line !== "string") return null;
  const m = line.match(/^\s*-\s*\(propose\s+(done|complete|cancel)\)\s*(.*)$/i);
  if (!m) return null;

  const action = m[1].toLowerCase() === "cancel" ? "cancel" : "complete";
  let rest = m[2];
  let evidence: string | undefined;
  let source: string | undefined;

  const evMatch = rest.match(/^(.*?)\s*-\s*evidence:\s*"([^"]*)"\s*(\[\[[^\]]*\]\])?\s*$/);
  if (evMatch) {
    rest = evMatch[1];
    evidence = evMatch[2];
    source = evMatch[3] ? evMatch[3].slice(2, -2) : undefined;
  }

  return {
    sourceId: ctx.sourceId,
    filePath: ctx.filePath,
    lineNo: ctx.lineNo,
    rawLine: line,
    action,
    text: rest.trim(),
    evidence,
    source,
  };
}

export interface ParsedTrackerFile {
  tasks: VtTask[];
  proposals: VtProposal[];
}

export function parseTrackerFile(
  content: string,
  source: TaskSourceSetting,
  _workspace?: RuntimeWorkspace
): ParsedTrackerFile {
  const tasks: VtTask[] = [];
  const proposals: VtProposal[] = [];

  if (typeof content !== "string") return { tasks, proposals };

  const lines = content.split(/\r?\n/);
  let heading = "";
  let lastTask: VtTask | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      heading = headingMatch[1];
      lastTask = null;
      continue;
    }

    const task = parseTaskLine(line, { sourceId: source.id, filePath: source.path, lineNo, heading });
    if (task) {
      tasks.push(task);
      lastTask = task;
      continue;
    }

    const proposal = source.proposals
      ? parseProposalLine(line, { sourceId: source.id, filePath: source.path, lineNo, heading })
      : null;
    if (proposal) {
      proposals.push(proposal);
      lastTask = null;
      continue;
    }

    const subNoteMatch = line.match(/^\s+-\s*📝\s*(.*)$/);
    if (subNoteMatch && lastTask) {
      lastTask.subNotes.push(subNoteMatch[1].trim());
      continue;
    }
  }

  return { tasks, proposals };
}

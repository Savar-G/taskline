import { insertAnnotation, setStatusChar } from "./format";
import { VtProposal, VtTask } from "./model";

export class VtStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VtStaleError";
  }
}

export class VtRecurrenceUnavailableError extends Error {
  constructor() {
    super("Recurring tasks require the Obsidian Tasks plugin. Enable it, then try again.");
    this.name = "VtRecurrenceUnavailableError";
  }
}

export class VtPartialMoveError extends Error {
  readonly recoveryInstructions = "The task may now exist in both files. Remove the destination copy only after confirming the source copy is still present.";

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "VtPartialMoveError";
  }
}

export class VtCrossFileProposalError extends Error {
  constructor(readonly proposalFile: string, readonly taskFile: string) {
    super(`Taskline can only confirm a proposal when it is in the same file as its target. Move the proposal to ${taskFile}, then confirm it again.`);
    this.name = "VtCrossFileProposalError";
  }
}

interface TextParts {
  lines: string[];
  eol: "\r\n" | "\n";
}

export interface TasksPluginApiV1 {
  executeToggleTaskDoneCommand: (line: string, filePath: string) => string | string[];
}

export function splitText(content: string): TextParts {
  return { lines: content.split(/\r?\n/), eol: content.includes("\r\n") ? "\r\n" : "\n" };
}

export function joinText(parts: TextParts): string {
  return parts.lines.join(parts.eol);
}

export function locateLine(lines: string[], rawLine: string, lineNoHint?: number): number {
  if (lineNoHint !== undefined) {
    const idx = lineNoHint - 1;
    if (idx >= 0 && idx < lines.length && lines[idx] === rawLine) return idx;
  }
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i] === rawLine) matches.push(i);
  if (matches.length !== 1) throw new VtStaleError(`taskline: expected exactly one matching line, found ${matches.length}`);
  return matches[0];
}

export function headingInsertIndex(lines: string[], heading: string): number {
  const headingIdx = lines.findIndex((line) => line.match(/^##\s+(.+?)\s*$/)?.[1] === heading);
  if (headingIdx === -1) throw new VtStaleError(`taskline: heading not found: ${heading}`);
  for (let i = headingIdx + 1; i < lines.length; i++) if (/^#{1,2}\s+/.test(lines[i])) return i;
  return lines.length;
}

export function editLineText(
  content: string,
  ref: { rawLine: string; lineNo?: number },
  edit: (line: string) => string | string[]
): string {
  const parts = splitText(content);
  const idx = locateLine(parts.lines, ref.rawLine, ref.lineNo);
  const result = edit(parts.lines[idx]);
  parts.lines.splice(idx, 1, ...(Array.isArray(result) ? result : [result]));
  return joinText(parts);
}

export function appendUnderHeadingText(content: string, heading: string, block: string[]): string {
  const parts = splitText(content);
  parts.lines.splice(headingInsertIndex(parts.lines, heading), 0, ...block);
  return joinText(parts);
}

export interface InsertedBlockReceipt {
  index: number;
  block: string[];
}

export function appendBlockText(
  content: string,
  heading: string,
  block: string[]
): { content: string; receipt: InsertedBlockReceipt } {
  const parts = splitText(content);
  const index = headingInsertIndex(parts.lines, heading);
  parts.lines.splice(index, 0, ...block);
  return { content: joinText(parts), receipt: { index, block: [...block] } };
}

export function rollbackInsertedBlockText(content: string, receipt: InsertedBlockReceipt): string {
  const parts = splitText(content);
  const exact = receipt.block.every((line, offset) => parts.lines[receipt.index + offset] === line);
  if (!exact) {
    throw new VtStaleError("taskline: the inserted destination block changed before rollback");
  }
  parts.lines.splice(receipt.index, receipt.block.length);
  return joinText(parts);
}

export async function runCrossFileMove<T>(operations: {
  appendDestination(): Promise<T>;
  removeSource(): Promise<void>;
  rollbackDestination(receipt: T): Promise<void>;
}): Promise<void> {
  const receipt = await operations.appendDestination();
  try {
    await operations.removeSource();
  } catch (sourceError) {
    try {
      await operations.rollbackDestination(receipt);
    } catch (rollbackError) {
      throw new VtPartialMoveError(
        "taskline: source removal failed and the exact destination insertion could not be rolled back. The task may now exist in both files; verify both files and remove only the extra destination copy.",
        { sourceError, rollbackError }
      );
    }
    throw sourceError;
  }
}

export function assertSameFileProposal(proposal: Pick<VtProposal, "filePath">, task: Pick<VtTask, "filePath">): void {
  if (proposal.filePath !== task.filePath) {
    throw new VtCrossFileProposalError(proposal.filePath, task.filePath);
  }
}

function indentationWidth(line: string): number {
  const whitespace = line.match(/^[\t ]*/)?.[0] ?? "";
  let width = 0;
  for (const char of whitespace) width += char === "\t" ? 4 : 1;
  return width;
}

export function blockLength(lines: string[], idx: number): number {
  const taskIndent = indentationWidth(lines[idx] ?? "");
  let length = 1;
  // A block is the task plus consecutive, nonblank lines indented deeper than it. A blank,
  // heading, or same/shallower-indented line starts the next top-level block.
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0 || indentationWidth(line) <= taskIndent) break;
    length++;
  }
  return length;
}

export function removeTaskBlockText(content: string, task: Pick<VtTask, "rawLine" | "lineNo">, expectedBlock: string[]): string {
  const parts = splitText(content);
  const idx = locateLine(parts.lines, task.rawLine, task.lineNo);
  const currentBlock = parts.lines.slice(idx, idx + blockLength(parts.lines, idx));
  if (currentBlock.length !== expectedBlock.length || currentBlock.some((line, offset) => line !== expectedBlock[offset])) {
    throw new VtStaleError("taskline: source task block changed before removal");
  }
  parts.lines.splice(idx, expectedBlock.length);
  return joinText(parts);
}

export function moveTaskWithinText(content: string, task: VtTask, newLine: string, heading: string): string {
  const parts = splitText(content);
  const sourceIdx = locateLine(parts.lines, task.rawLine, task.lineNo);
  const length = blockLength(parts.lines, sourceIdx);
  const notes = parts.lines.slice(sourceIdx + 1, sourceIdx + length);
  parts.lines.splice(sourceIdx, length);
  parts.lines.splice(headingInsertIndex(parts.lines, heading), 0, newLine, ...notes);
  return joinText(parts);
}

const DONE_LINE_RE = /^\s*-\s*\[[xX]\]/;

export function toggleUntilDone(api: TasksPluginApiV1, line: string, filePath: string): string[] | null {
  let current = line;
  for (let i = 0; i < 8; i++) {
    const result = api.executeToggleTaskDoneCommand(current, filePath);
    const lines = Array.isArray(result) ? result : result.split(/\r?\n/);
    if (lines.some((item) => DONE_LINE_RE.test(item))) return lines;
    if (lines.length !== 1 || lines[0] === current) return null;
    current = lines[0];
  }
  return null;
}

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function cancelLine(task: VtTask, line: string, source?: string): string {
  const annotated = source ? insertAnnotation(line, `(reconciled from ${source})`) : line;
  return insertAnnotation(setStatusChar(annotated, "-"), `❌ ${todayIso()}`);
}

export function applyProposalText(
  content: string,
  proposal: VtProposal,
  task: VtTask,
  api: TasksPluginApiV1 | null
): string {
  const source = proposal.source ?? "proposal";
  const mutated = editLineText(content, task, (line) => proposal.action === "cancel"
    ? cancelLine(task, line, source)
    : completeLine(api, task, insertAnnotation(line, `(reconciled from ${source})`)));
  return editLineText(mutated, { rawLine: proposal.rawLine }, () => []);
}

export function completeLine(api: TasksPluginApiV1 | null, task: VtTask, line: string): string | string[] {
  if (api) {
    const done = toggleUntilDone(api, line, task.filePath);
    if (done) return done;
  }
  if (task.recurrence) throw new VtRecurrenceUnavailableError();
  return insertAnnotation(setStatusChar(line, "x"), `✅ ${todayIso()}`);
}

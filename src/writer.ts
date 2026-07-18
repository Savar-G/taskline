import { App, TFile } from "obsidian";
import { VtTask } from "./model";
import { insertAnnotation, setStatusChar } from "./format";
import {
  appendUnderHeadingText,
  appendBlockText,
  applyProposalText,
  assertSameFileProposal,
  blockLength,
  completeLine,
  editLineText,
  locateLine,
  moveTaskWithinText,
  rollbackInsertedBlockText,
  removeTaskBlockText,
  runCrossFileMove,
  splitText,
  TasksPluginApiV1,
  VtRecurrenceUnavailableError,
  InsertedBlockReceipt,
  VtStaleError,
} from "./writerCore";

export { VtCrossFileProposalError, VtPartialMoveError, VtRecurrenceUnavailableError, VtStaleError } from "./writerCore";

interface LineRef {
  filePath: string;
  rawLine: string;
  lineNo?: number;
}

async function getFileOrThrow(app: App, filePath: string): Promise<TFile> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) throw new VtStaleError(`taskline: file not found: ${filePath}`);
  return file;
}

async function processFile(app: App, filePath: string, callback: (content: string) => string): Promise<void> {
  const file = await getFileOrThrow(app, filePath);
  await app.vault.process(file, callback);
}

async function editLine(app: App, ref: LineRef, edit: (line: string) => string | string[]): Promise<void> {
  await processFile(app, ref.filePath, (content) => editLineText(content, ref, edit));
}

function getTasksPluginApi(app: App): TasksPluginApiV1 | null {
  const anyApp = app as unknown as { plugins?: { plugins?: Record<string, { apiV1?: TasksPluginApiV1 }> } };
  return anyApp.plugins?.plugins?.["obsidian-tasks-plugin"]?.apiV1 ?? null;
}

export async function completeTask(app: App, task: VtTask): Promise<void> {
  const api = getTasksPluginApi(app);
  if (task.recurrence && !api) throw new VtRecurrenceUnavailableError();
  await editLine(app, task, (line) => completeLine(api, task, line));
}

export async function reconcileAndComplete(app: App, task: VtTask, source: string): Promise<void> {
  const api = getTasksPluginApi(app);
  if (task.recurrence && !api) throw new VtRecurrenceUnavailableError();
  await editLine(app, task, (line) => completeLine(api, task, insertAnnotation(line, `(reconciled from ${source})`)));
}

export async function applyProposal(app: App, proposal: import("./model").VtProposal, task: VtTask): Promise<void> {
  assertSameFileProposal(proposal, task);
  const api = getTasksPluginApi(app);
  if (proposal.action === "complete" && task.recurrence && !api) throw new VtRecurrenceUnavailableError();
  await processFile(app, task.filePath, (content) => applyProposalText(content, proposal, task, api));
}

export async function setTaskStatus(app: App, task: VtTask, char: string, annotation?: string): Promise<void> {
  await editLine(app, task, (line) => annotation ? insertAnnotation(setStatusChar(line, char), annotation) : setStatusChar(line, char));
}

export async function removeLine(app: App, ref: LineRef): Promise<void> {
  await editLine(app, ref, () => []);
}

export async function appendUnderHeading(app: App, filePath: string, heading: string, line: string | string[]): Promise<void> {
  const block = Array.isArray(line) ? line : [line];
  await processFile(app, filePath, (content) => appendUnderHeadingText(content, heading, block));
}

export async function replaceTaskLine(app: App, task: VtTask, newLine: string): Promise<void> {
  await editLine(app, task, () => newLine);
}

export async function moveTaskLine(
  app: App,
  task: VtTask,
  newLine: string,
  dest: { file: string; heading: string }
): Promise<void> {
  if (dest.file === task.filePath) {
    await processFile(app, task.filePath, (content) => moveTaskWithinText(content, task, newLine, dest.heading));
    return;
  }

  let sourceBlock: string[] = [];
  let movedBlock: string[] = [];
  await processFile(app, task.filePath, (content) => {
    const parts = splitText(content);
    const idx = locateLine(parts.lines, task.rawLine, task.lineNo);
    const length = blockLength(parts.lines, idx);
    sourceBlock = parts.lines.slice(idx, idx + length);
    movedBlock = [newLine, ...sourceBlock.slice(1)];
    return content;
  });
  await runCrossFileMove<InsertedBlockReceipt>({
    appendDestination: async () => {
      let receipt: InsertedBlockReceipt | null = null;
      await processFile(app, dest.file, (content) => {
        const result = appendBlockText(content, dest.heading, movedBlock);
        receipt = result.receipt;
        return result.content;
      });
      if (!receipt) throw new VtStaleError("taskline: destination append did not return a receipt");
      return receipt;
    },
    removeSource: () => processFile(app, task.filePath, (content) => removeTaskBlockText(content, task, sourceBlock)),
    rollbackDestination: (receipt) => processFile(app, dest.file, (content) => rollbackInsertedBlockText(content, receipt)),
  });
}

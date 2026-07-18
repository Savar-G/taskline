import { App, TAbstractFile, TFile } from "obsidian";
import { parseTrackerFile } from "./parser";
import { VtProposal, VtTask } from "./model";
import {
  AreaGroup,
  CompletedResult,
  DayGroup,
  allOpenGrouped,
  completedRecent,
  isTaskOverdue,
  isTaskToday,
  inboxTasks,
  laterTasks,
  undatedOpenTasks,
  upcomingByDay,
} from "./query";
import type { RuntimeWorkspace } from "./settings";

export type VtChangeListener = () => void;

/** Reads and parses the tracked vault files, keeps them in sync via vault 'modify' events,
 * and exposes simple query helpers for the Today view. This module imports 'obsidian' and
 * is not unit-tested directly - the pure parsing/formatting logic it wraps lives in
 * parser.ts / format.ts and IS unit-tested. */
export class VtStore {
  private app: App;
  private workspace: RuntimeWorkspace;
  private tasksByFile: Map<string, VtTask[]> = new Map();
  private proposalsByFile: Map<string, VtProposal[]> = new Map();
  private listeners: Set<VtChangeListener> = new Set();
  private eventRefs: Array<ReturnType<App["vault"]["on"]>> = [];
  private reparseGeneration: Map<string, number> = new Map();
  private disposed = false;

  constructor(app: App, workspace: RuntimeWorkspace) {
    this.app = app;
    this.workspace = workspace;
  }

  async init(): Promise<void> {
    this.disposed = false;
    for (const source of this.workspace.sources) {
      await this.reparseFile(source.path);
    }

    const reparseConfigured = (file: TAbstractFile): void => {
      if (!(file instanceof TFile)) return;
      const source = this.workspace.sourceByPath.get(file.path.toLowerCase());
      if (source) {
        void this.reparseFile(source.path)
          .then((applied) => applied && this.notify())
          .catch((error) => console.error(`taskline: could not reparse ${source.path}`, error));
      }
    };
    this.eventRefs.push(this.app.vault.on("modify", reparseConfigured));
    this.eventRefs.push(this.app.vault.on("create", reparseConfigured));
    this.eventRefs.push(this.app.vault.on("delete", (file: TAbstractFile) => {
      const source = this.workspace.sourceByPath.get(file.path.toLowerCase());
      if (!source) return;
      this.invalidate(source.path);
      this.tasksByFile.set(source.path, []);
      this.proposalsByFile.set(source.path, []);
      this.notify();
    }));
    this.eventRefs.push(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
      const oldSource = this.workspace.sourceByPath.get(oldPath.toLowerCase());
      if (oldSource) {
        this.invalidate(oldSource.path);
        this.tasksByFile.set(oldSource.path, []);
        this.proposalsByFile.set(oldSource.path, []);
        this.notify();
      }
      reparseConfigured(file);
    }));

    // Consumers that subscribe before init still receive the first complete snapshot.
    this.notify();
  }

  private invalidate(path: string): number {
    const generation = (this.reparseGeneration.get(path) ?? 0) + 1;
    this.reparseGeneration.set(path, generation);
    return generation;
  }

  private async reparseFile(path: string): Promise<boolean> {
    const generation = this.invalidate(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      if (this.disposed || this.reparseGeneration.get(path) !== generation) return false;
      this.tasksByFile.set(path, []);
      this.proposalsByFile.set(path, []);
      return true;
    }
    const content = await this.app.vault.cachedRead(file);
    if (this.disposed || this.reparseGeneration.get(path) !== generation) return false;
    const source = this.workspace.sourceByPath.get(path.toLowerCase());
    if (!source) return false;
    const { tasks, proposals } = parseTrackerFile(content, source, this.workspace);
    this.tasksByFile.set(path, tasks);
    this.proposalsByFile.set(path, proposals);
    return true;
  }

  getTasks(): VtTask[] {
    const all: VtTask[] = [];
    for (const source of this.workspace.sources) {
      all.push(...(this.tasksByFile.get(source.path) ?? []));
    }
    return all;
  }

  getProposals(): VtProposal[] {
    const all: VtProposal[] = [];
    for (const source of this.workspace.sources) {
      all.push(...(this.proposalsByFile.get(source.path) ?? []));
    }
    return all;
  }

  private isOpen(task: VtTask): boolean {
    return task.status !== "done" && task.status !== "cancelled";
  }

  overdueTasks(today: Date): VtTask[] {
    return this.getTasks().filter((task) => isTaskOverdue(task, today));
  }

  dueToday(today: Date): VtTask[] {
    return this.getTasks().filter((task) => this.isOpen(task) && isTaskToday(task, today));
  }

  // ---- tracker-tab query helpers (delegate to the pure query layer) --------

  upcomingByDay(today: Date, days = 7): DayGroup[] {
    return upcomingByDay(this.getTasks(), today, days);
  }

  laterTasks(today: Date, afterDays = 7): VtTask[] {
    return laterTasks(this.getTasks(), today, afterDays);
  }

  undatedOpenTasks(): VtTask[] {
    return undatedOpenTasks(this.getTasks());
  }

  allOpenGrouped(): AreaGroup[] {
    return allOpenGrouped(this.getTasks(), this.workspace);
  }

  inboxTasks(): VtTask[] {
    return inboxTasks(this.getTasks(), this.workspace);
  }

  completedRecent(limit = 30): CompletedResult {
    return completedRecent(this.getTasks(), limit);
  }

  onChange(cb: VtChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  dispose(): void {
    this.disposed = true;
    for (const ref of this.eventRefs) this.app.vault.offref(ref);
    this.eventRefs = [];
    for (const source of this.workspace.sources) this.invalidate(source.path);
    this.listeners.clear();
  }
}

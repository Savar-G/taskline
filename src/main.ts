import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { TodayView, VIEW_TYPE_TODAY, VtTabId } from "./todayView";
import { VtStore } from "./store";
import { VtTask } from "./model";
import { CaptureModal } from "./ui/captureModal";
import { VtEditModal } from "./ui/editModal";
import { compileWorkspace, DEFAULT_SETTINGS, RuntimeWorkspace, SettingsIssue, TasklineSettings } from "./settings";
import { TasklineSettingTab } from "./settingsTab";

export default class TasklinePlugin extends Plugin {
  settings: TasklineSettings = DEFAULT_SETTINGS;
  workspace: RuntimeWorkspace = compileWorkspace(DEFAULT_SETTINGS);
  store: VtStore | null = null;
  settingsLoadIssues: SettingsIssue[] = [];
  rejectedSettingsRaw: unknown = null;
  private initializingStore: VtStore | null = null;
  private storeReadyCbs: Set<() => void> = new Set();
  private settingsCbs: Set<() => void> = new Set();
  private loaded = false;
  private storeGeneration = 0;
  private settingsWrite: Promise<void> = Promise.resolve();

  activeTab: VtTabId = "today";
  activeFilters: Set<string> = new Set();
  expandedGroups: Set<string> = new Set();

  async onload(): Promise<void> {
    this.loaded = true;
    const rawSettings = await this.loadData();
    const loadedWorkspace = compileWorkspace(rawSettings);
    this.settingsLoadIssues = loadedWorkspace.issues.filter((issue) => issue.level === "error");
    this.rejectedSettingsRaw = this.settingsLoadIssues.length > 0 ? rawSettings : null;
    this.workspace = loadedWorkspace.issues.some((issue) => issue.level === "error")
      ? compileWorkspace(DEFAULT_SETTINGS)
      : loadedWorkspace;
    this.settings = this.workspace.settings;
    this.addSettingTab(new TasklineSettingTab(this));

    this.registerView(VIEW_TYPE_TODAY, (leaf: WorkspaceLeaf) => new TodayView(leaf, this));
    this.addRibbonIcon("check-circle", "Open Taskline Today", () => void this.openTodayView());
    this.addCommand({ id: "open-today", name: "Open Today", callback: () => void this.openTodayView() });
    this.addCommand({ id: "add-task", name: "Add task", callback: () => this.openCapture() });

    this.app.workspace.onLayoutReady(() => {
      if (!this.loaded) return;
      void this.initializeStore();
    });
  }

  onunload(): void {
    this.loaded = false;
    this.store?.dispose();
    this.initializingStore?.dispose();
    this.store = null;
    this.initializingStore = null;
    this.storeReadyCbs.clear();
    this.settingsCbs.clear();
  }

  async updateSettings(candidate: unknown): Promise<void> {
    const operation = this.settingsWrite.then(() => this.applySettings(candidate));
    this.settingsWrite = operation.catch(() => {});
    return operation;
  }

  private async applySettings(candidateSettings: unknown): Promise<void> {
    const compiled = compileWorkspace(candidateSettings);
    const errors = compiled.issues.filter((issue) => issue.level === "error");
    if (errors.length > 0) throw new Error(`Invalid Taskline settings: ${errors[0].path} - ${errors[0].message}`);

    const generation = ++this.storeGeneration;
    this.initializingStore?.dispose();
    const candidate = compiled.configured ? new VtStore(this.app, compiled) : null;
    this.initializingStore = candidate;
    try {
      if (candidate) await candidate.init();
      if (!this.loaded || generation !== this.storeGeneration) {
        candidate?.dispose();
        return;
      }
      await this.saveData(compiled.settings);
    } catch (error) {
      candidate?.dispose();
      if (this.initializingStore === candidate) this.initializingStore = null;
      throw error;
    }

    const old = this.store;
    this.settings = compiled.settings;
    this.workspace = compiled;
    this.settingsLoadIssues = [];
    this.rejectedSettingsRaw = null;
    this.store = candidate;
    this.initializingStore = null;
    old?.dispose();
    this.flushStoreReady();
    for (const callback of this.settingsCbs) callback();
  }

  private async initializeStore(): Promise<void> {
    const generation = ++this.storeGeneration;
    this.initializingStore?.dispose();
    if (!this.workspace.configured) {
      const old = this.store;
      this.store = null;
      old?.dispose();
      this.flushStoreReady();
      return;
    }

    const candidate = new VtStore(this.app, this.workspace);
    this.initializingStore = candidate;
    try {
      await candidate.init();
    } catch (error) {
      candidate.dispose();
      if (this.initializingStore === candidate) this.initializingStore = null;
      console.error("taskline: store initialization failed", error);
      return;
    }
    if (!this.loaded || generation !== this.storeGeneration || this.initializingStore !== candidate) {
      candidate.dispose();
      return;
    }
    const old = this.store;
    this.store = candidate;
    this.initializingStore = null;
    old?.dispose();
    this.flushStoreReady();
  }

  private flushStoreReady(): void {
    const callbacks = [...this.storeReadyCbs];
    this.storeReadyCbs.clear();
    for (const cb of callbacks) cb();
  }

  whenStoreReady(cb: () => void): () => void {
    if (this.store || !this.workspace.configured) {
      window.setTimeout(cb, 0);
      return () => {};
    }
    this.storeReadyCbs.add(cb);
    return () => this.storeReadyCbs.delete(cb);
  }

  onSettingsChange(cb: () => void): () => void {
    this.settingsCbs.add(cb);
    return () => this.settingsCbs.delete(cb);
  }

  openSettings(): void {
    const setting = (this.app as typeof this.app & {
      setting?: { open(): void; openTabById(id: string): void };
    }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  openCapture(): void {
    if (!this.workspace.configured) {
      new Notice("Configure task sources in Taskline settings first.");
      this.openSettings();
      return;
    }
    new CaptureModal(this.app, this).open();
  }

  openEdit(task: VtTask): void {
    new VtEditModal(this.app, this, task).open();
  }

  async openTodayView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TODAY)[0];
    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_TODAY, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}

import { VtTask } from "../src/model";
import { compileWorkspace } from "../src/settings";

export const WORKSPACE = compileWorkspace({
  version: 1,
  sources: [
    { id: "tasks", label: "Tasks", path: "Tasks.md", role: "tasks", editPolicy: "route", proposals: true },
    { id: "team", label: "Shared", path: "Shared/Tasks.md", role: "tasks", groupId: "shared", editPolicy: "stay", proposals: false },
    { id: "inbox", label: "Inbox", path: "Inbox.md", role: "inbox", editPolicy: "route", proposals: false },
  ],
  sourceGroups: [
    { id: "shared", label: "Shared work", mode: "by-heading", ownerDisplay: true, color: "--color-purple" },
  ],
  areas: [
    { id: "writing", label: "Writing", sourceId: "tasks", heading: "Writing", color: "--color-pink" },
    { id: "learning", label: "Learning", sourceId: "tasks", heading: "Learning", color: "--color-blue" },
  ],
  captureRoutes: [
    { tag: "writing", aliases: ["write"], destination: { sourceId: "tasks", heading: "Writing" }, keywords: ["article", "draft"], showAsChip: true },
    { tag: "learning", aliases: ["study"], destination: { sourceId: "tasks", heading: "Learning" }, keywords: ["course", "exam"], showAsChip: true },
    { tag: "shared", aliases: [], destination: { sourceId: "team", heading: "General" }, keywords: ["handoff"], showAsChip: false },
  ],
  tagFilters: [{ tag: "automated", label: "Automated", color: "--color-green" }],
  displayOrder: ["writing", "learning", "shared"],
  fallbackCaptureDestination: { sourceId: "inbox", heading: "Captured" },
  ownerSelfAliases: ["me", "self"],
});

export function makeTask(partial: Partial<VtTask> & { title: string }): VtTask {
  return {
    sourceId: "tasks",
    filePath: "Tasks.md",
    lineNo: 1,
    rawLine: "",
    status: "todo",
    statusChar: " ",
    tags: [],
    priority: null,
    heading: "Writing",
    subNotes: [],
    ...partial,
  };
}

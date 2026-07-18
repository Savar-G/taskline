import { describe, expect, it } from "vitest";
import { compileWorkspace, createSettingsDraft, DEFAULT_SETTINGS, normalizeVaultPath } from "../src/settings";
import { WORKSPACE } from "./fixtures";

describe("settings workspace", () => {
  it("ships unconfigured and contains no implicit sources", () => {
    const workspace = compileWorkspace(DEFAULT_SETTINGS);
    expect(workspace.configured).toBe(false);
    expect(workspace.sources).toEqual([]);
    expect(workspace.issues).toEqual([]);
  });

  it("normalizes configured paths", () => {
    expect(normalizeVaultPath(" /Folder\\Nested//Tasks.md ")).toBe("Folder/Nested/Tasks.md");
    expect(WORKSPACE.sourceById.get("team")?.path).toBe("Shared/Tasks.md");
  });

  it.each(["../../Tasks.md", "Folder/../Tasks.md", "/Tasks.md", "\\Tasks.md", "C:\\Tasks.md"])(
    "rejects source paths outside the vault: %s",
    (path) => {
      const workspace = compileWorkspace({
        ...DEFAULT_SETTINGS,
        sources: [{ id: "tasks", label: "Tasks", path }],
      });
      expect(workspace.configured).toBe(false);
      expect(workspace.issues).toContainEqual({
        level: "error",
        path: "sources.0.path",
        message: "Source path must stay within the vault.",
      });
    }
  );

  it("reports duplicate IDs, duplicate normalized paths, and broken references", () => {
    const workspace = compileWorkspace({
      version: 1,
      sources: [
        { id: "tasks", label: "One", path: "Folder\\Tasks.md", role: "tasks", editPolicy: "route", proposals: false },
        { id: "tasks", label: "Two", path: "Folder/Tasks.md", role: "tasks", groupId: "missing", editPolicy: "route", proposals: false },
      ],
      sourceGroups: [],
      areas: [{ id: "area", label: "Area", sourceId: "missing", heading: "Area" }],
      captureRoutes: [{ tag: "area", aliases: [], destination: { sourceId: "missing", heading: "Area" }, keywords: [], showAsChip: true }],
      tagFilters: [],
      displayOrder: ["missing"],
      fallbackCaptureDestination: { sourceId: "missing", heading: "Captured" },
      ownerSelfAliases: [],
    });
    expect(workspace.configured).toBe(false);
    expect(workspace.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "Duplicate source ID: tasks",
      "Duplicate source path: folder/tasks.md",
      "Unknown source group: missing",
      "Unknown source: missing",
      "Unknown area or group: missing",
    ]));
  });

  it("indexes route aliases, headings, filters, and self aliases", () => {
    expect(WORKSPACE.routeByTag.get("write")?.tag).toBe("writing");
    expect(WORKSPACE.areasBySourceHeading.get("tasks\u0000writing")?.id).toBe("writing");
    expect(WORKSPACE.tagFilterByTag.get("automated")?.label).toBe("Automated");
    expect(WORKSPACE.selfAliases.has("me")).toBe(true);
  });

  it.each([
    ["sources", [null]],
    ["sources", ["bad"]],
    ["sourceGroups", [null]],
    ["areas", [42]],
    ["captureRoutes", [null]],
    ["tagFilters", [false]],
    ["displayOrder", [null]],
    ["ownerSelfAliases", [{}]],
    ["sources", null],
  ])("defensively rejects malformed %s without throwing", (key, value) => {
    const input = { ...DEFAULT_SETTINGS, [key]: value };
    expect(() => compileWorkspace(input)).not.toThrow();
    expect(compileWorkspace(input).issues.some((issue) => issue.level === "error")).toBe(true);
    expect(compileWorkspace(input).configured).toBe(false);
  });

  it("rejects unsupported future schema versions", () => {
    const workspace = compileWorkspace({ ...DEFAULT_SETTINGS, version: 999 });
    expect(workspace.configured).toBe(false);
    expect(workspace.issues).toContainEqual({
      level: "error",
      path: "version",
      message: "Unsupported future schema version: 999",
    });
  });

  it.each([null, "1", 1.5, 0])("rejects invalid explicit schema version %j", (version) => {
    const workspace = compileWorkspace({ ...DEFAULT_SETTINGS, version });
    expect(workspace.issues.some((issue) => issue.path === "version" && issue.level === "error")).toBe(true);
  });

  it.each([
    ["role", "archive", "sources.0.role"],
    ["editPolicy", "copy", "sources.0.editPolicy"],
    ["proposals", "yes", "sources.0.proposals"],
  ])("rejects invalid source %s instead of coercing it", (key, value, expectedPath) => {
    const input = JSON.parse(JSON.stringify(WORKSPACE.settings));
    input.sources[0][key] = value;
    const workspace = compileWorkspace(input);
    expect(workspace.configured).toBe(false);
    expect(workspace.issues).toContainEqual(expect.objectContaining({ level: "error", path: expectedPath }));
  });

  it.each([
    ["mode", "nested", "sourceGroups.0.mode"],
    ["ownerDisplay", "yes", "sourceGroups.0.ownerDisplay"],
    ["color", 42, "sourceGroups.0.color"],
  ])("rejects invalid source-group %s instead of activating it", (key, value, expectedPath) => {
    const input = JSON.parse(JSON.stringify(WORKSPACE.settings));
    input.sourceGroups[0][key] = value;
    const workspace = compileWorkspace(input);
    expect(workspace.configured).toBe(false);
    expect(workspace.issues).toContainEqual(expect.objectContaining({ level: "error", path: expectedPath }));
  });

  it.each([
    ["areas", "color", "not a color; color:red", "areas.0.color"],
    ["tagFilters", "color", {}, "tagFilters.0.color"],
    ["captureRoutes", "showAsChip", 1, "captureRoutes.0.showAsChip"],
    ["captureRoutes", "destination", [], "captureRoutes.0.destination"],
  ])("rejects invalid %s.%s shape or value", (collection, key, value, expectedPath) => {
    const input = JSON.parse(JSON.stringify(WORKSPACE.settings));
    input[collection][0][key] = value;
    const workspace = compileWorkspace(input);
    expect(workspace.configured).toBe(false);
    expect(workspace.issues).toContainEqual(expect.objectContaining({ level: "error", path: expectedPath }));
  });

  it("keeps backward-compatible defaults for omitted optional source and group fields", () => {
    const workspace = compileWorkspace({
      ...DEFAULT_SETTINGS,
      sources: [{ id: "tasks", label: "Tasks", path: "Tasks.md" }],
      sourceGroups: [{ id: "group", label: "Group" }],
    });
    expect(workspace.issues.filter((issue) => issue.level === "error")).toEqual([]);
    expect(workspace.sources[0]).toMatchObject({ role: "tasks", editPolicy: "route", proposals: false });
    expect(workspace.settings.sourceGroups[0]).toMatchObject({ mode: "flat", ownerDisplay: false });
  });

  it("uses a rejected raw object as the repair draft without mutating the raw or active settings", () => {
    const rejected = {
      ...JSON.parse(JSON.stringify(WORKSPACE.settings)),
      sources: [{ ...WORKSPACE.settings.sources[0], role: "invalid-role" }],
    };
    const activeBefore = JSON.stringify(DEFAULT_SETTINGS);
    const rejectedBefore = JSON.stringify(rejected);
    const draft = createSettingsDraft(DEFAULT_SETTINGS, rejected);
    expect((draft.sources as Array<{ role: string }>)[0].role).toBe("invalid-role");
    expect(compileWorkspace(draft).configured).toBe(false);
    (draft.sources as Array<{ role: string }>)[0].role = "tasks";
    expect(JSON.stringify(rejected)).toBe(rejectedBefore);
    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(activeBefore);
  });

  it("preserves explicit rejected null shapes in the repair draft", () => {
    const draft = createSettingsDraft(WORKSPACE.settings, { ...WORKSPACE.settings, sources: null });
    expect(draft.sources).toBeNull();
    expect(compileWorkspace(draft).configured).toBe(false);
  });
});

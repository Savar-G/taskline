import { describe, expect, it } from "vitest";
import {
  allOpenGrouped,
  completedRecent,
  effectiveTaskIso,
  inboxTasks,
  isTaskOverdue,
  isTaskToday,
  laterTasks,
  taskArea,
  undatedOpenTasks,
  upcomingByDay,
} from "../src/query";
import { makeTask, WORKSPACE } from "./fixtures";

const TODAY = new Date(2026, 6, 2);

describe("date windows", () => {
  const tasks = [
    makeTask({ title: "today", due: "2026-07-02" }),
    makeTask({ title: "tomorrow", due: "2026-07-03" }),
    makeTask({ title: "day seven", due: "2026-07-09" }),
    makeTask({ title: "day eight", due: "2026-07-10" }),
    makeTask({ title: "undated" }),
    makeTask({ title: "done", status: "done", statusChar: "x", due: "2026-07-04" }),
  ];

  it("buckets open tasks from tomorrow through day seven", () => {
    const days = upcomingByDay(tasks, TODAY);
    expect(days).toHaveLength(7);
    expect(days[0].tasks.map((task) => task.title)).toEqual(["tomorrow"]);
    expect(days[6].tasks.map((task) => task.title)).toEqual(["day seven"]);
  });

  it("puts only dates beyond the window in later", () => {
    expect(laterTasks(tasks, TODAY).map((task) => task.title)).toEqual(["day eight"]);
  });

  it("returns all open undated tasks", () => {
    expect(undatedOpenTasks(tasks).map((task) => task.title)).toEqual(["undated"]);
  });

  it.each([
    ["2026-07-04", "2026-07-03", "2026-07-03"],
    ["2026-07-03", "2026-07-04", "2026-07-03"],
    ["2026-07-03", undefined, "2026-07-03"],
    [undefined, "2026-07-04", "2026-07-04"],
  ])("uses the earliest scheduled/due date as the effective date", (due, scheduled, expected) => {
    expect(effectiveTaskIso(makeTask({ title: "Both", due, scheduled }))).toBe(expected);
  });

  it("classifies a task by its earliest date across today and overdue", () => {
    const task = makeTask({ title: "Mixed", scheduled: "2026-07-01", due: "2026-07-02" });
    expect(isTaskOverdue(task, TODAY)).toBe(true);
    expect(isTaskToday(task, TODAY)).toBe(false);
  });

  it("places a mixed-date task in one upcoming bucket using the earliest date", () => {
    const task = makeTask({ title: "Mixed", scheduled: "2026-07-04", due: "2026-07-03" });
    const groups = upcomingByDay([task], TODAY);
    expect(groups[0].tasks).toEqual([task]);
    expect(groups[1].tasks).toEqual([]);
  });

  it("does not place a task in later when its earlier date is within the window", () => {
    const task = makeTask({ title: "Mixed", scheduled: "2026-07-03", due: "2026-07-20" });
    expect(laterTasks([task], TODAY)).toEqual([]);
  });
});

describe("workspace grouping", () => {
  it("uses area IDs, group IDs, and null for inbox identity", () => {
    expect(taskArea(makeTask({ title: "area", heading: "Writing" }), WORKSPACE)).toBe("writing");
    expect(taskArea(makeTask({ title: "group", sourceId: "team", filePath: "Shared/Tasks.md" }), WORKSPACE)).toBe("shared");
    expect(taskArea(makeTask({ title: "inbox", sourceId: "inbox", filePath: "Inbox.md" }), WORKSPACE)).toBeNull();
  });

  it("orders configured areas, retains unknown headings, and combines grouped sources", () => {
    const groups = allOpenGrouped([
      makeTask({ title: "learn", heading: "Learning" }),
      makeTask({ title: "write", heading: "Writing" }),
      makeTask({ title: "unknown", heading: "Someday" }),
      makeTask({ title: "shared", sourceId: "team", filePath: "Shared/Tasks.md", heading: "Platform" }),
    ], WORKSPACE);
    expect(groups.map((group) => group.label)).toEqual(["Writing", "Learning", "Shared work", "Someday"]);
    expect(groups.find((group) => group.key === "shared")?.mode).toBe("by-heading");
  });

  it("selects inbox tasks by configured role rather than path", () => {
    const inbox = makeTask({ title: "capture", sourceId: "inbox", filePath: "Inbox.md" });
    expect(inboxTasks([inbox, makeTask({ title: "task" })], WORKSPACE)).toEqual([inbox]);
  });
});

describe("completedRecent", () => {
  it("sorts newest first and reports truncation", () => {
    const tasks = Array.from({ length: 4 }, (_, index) => makeTask({
      title: `done ${index}`,
      status: "done",
      statusChar: "x",
      doneDate: `2026-07-0${index + 1}`,
    }));
    const result = completedRecent(tasks, 2);
    expect(result.tasks.map((task) => task.title)).toEqual(["done 3", "done 2"]);
    expect(result.truncated).toBe(true);
  });

  it("uses cancellation dates when no done date exists", () => {
    const result = completedRecent([
      makeTask({ title: "cancelled", status: "cancelled", statusChar: "-", cancelledDate: "2026-07-02" }),
      makeTask({ title: "done", status: "done", statusChar: "x", doneDate: "2026-07-01" }),
    ]);
    expect(result.tasks.map((task) => task.title)).toEqual(["cancelled", "done"]);
  });
});

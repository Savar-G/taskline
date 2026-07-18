import { describe, expect, it } from "vitest";
import {
  knownCaptureTags,
  mergeEditDates,
  parseCapture,
  resolveEditDestination,
  serializeCapturedTask,
  suggestArea,
  taskToCaptureString,
} from "../src/captureRules";
import { makeTask, WORKSPACE } from "./fixtures";

const TODAY = new Date(2026, 6, 2);

describe("parseCapture", () => {
  it("parses priority, date, title, and exact token spans", () => {
    const input = "send the report by tomorrow !!";
    const result = parseCapture(input, TODAY, WORKSPACE);
    expect(result).toMatchObject({ title: "send the report", priority: "p2", due: "2026-07-03" });
    expect(input.slice(result.tokens[0].start, result.tokens[0].end)).toBe("by tomorrow");
  });

  it("uses date-only storage and leaves unsupported time text in the title", () => {
    const parsed = parseCapture("pack today at 2pm", TODAY, WORKSPACE);
    expect(parsed.due).toBe("2026-07-02");
    expect(parsed.title).toBe("pack at 2pm");
  });

  it("parses weekdays, relative windows, and calendar forms", () => {
    expect(parseCapture("gym monday", TODAY, WORKSPACE).due).toBe("2026-07-06");
    expect(parseCapture("gym next thursday", TODAY, WORKSPACE).due).toBe("2026-07-09");
    expect(parseCapture("plan next week", TODAY, WORKSPACE).due).toBe("2026-07-06");
    expect(parseCapture("follow up in 2 weeks", TODAY, WORKSPACE).due).toBe("2026-07-16");
    expect(parseCapture("event Jul 4", TODAY, WORKSPACE).due).toBe("2026-07-04");
    expect(parseCapture("event 4 July", TODAY, WORKSPACE).due).toBe("2026-07-04");
    expect(parseCapture("event 7/4", TODAY, WORKSPACE).due).toBe("2026-07-04");
  });

  it.each([
    ["gym thursday", "2026-07-02"],
    ["event Apr 15", "2027-04-15"],
    ["follow up in 3 days", "2026-07-05"],
    ["start starting tomorrow", "2026-07-03"],
  ])("resolves date grammar in %s", (input, expected) => {
    const result = parseCapture(input, TODAY, WORKSPACE);
    expect(result.due ?? result.scheduled).toBe(expected);
  });

  it.each([
    ["ship !!!", "p1"],
    ["ship !!", "p2"],
    ["ship !", "p3"],
    ["ship priority:low", "p4"],
  ] as const)("resolves priority grammar in %s", (input, expected) => {
    expect(parseCapture(input, TODAY, WORKSPACE).priority).toBe(expected);
  });

  it("routes by the first configured tag while preserving tag order", () => {
    const result = parseCapture("draft article #write #automated #learning", TODAY, WORKSPACE);
    expect(result.tags).toEqual(["write", "automated", "learning"]);
    expect(result.destination).toEqual({ sourceId: "tasks", heading: "Writing" });
  });

  it("retains owners and tags containing task-compatible separators", () => {
    const result = parseCapture("review #client/work-stream #follow-up @alex-smith", TODAY, WORKSPACE);
    expect(result).toMatchObject({
      title: "review",
      owner: "alex-smith",
      tags: ["client/work-stream", "follow-up"],
    });
  });

  it("serializes routed owners and generic tags without dropping either", () => {
    const parsed = parseCapture("review #writing #client/work-stream @alex-smith", TODAY, WORKSPACE);
    expect(serializeCapturedTask(parsed, "2026-07-02")).toBe(
      "- [ ] review #writing #client/work-stream (from inbox 2026-07-02) — @alex-smith"
    );
  });

  it("persists the complete preview metadata even when the destination is inbox", () => {
    const parsed = parseCapture("sync records #automated @alex every week by 2026-07-04 !!", TODAY, WORKSPACE);
    expect(parsed.destination).toEqual({ sourceId: "inbox", heading: "Captured" });
    expect(serializeCapturedTask(parsed, "2026-07-02")).toBe(
      "- [ ] sync records #automated (from inbox 2026-07-02) — @alex ⏫ 🔁 every week 📅 2026-07-04"
    );
  });

  it("marks only configured route tags as explicit routes", () => {
    expect(parseCapture("draft #writing", TODAY, WORKSPACE).explicitRouteMatched).toBe(true);
    expect(parseCapture("draft #automated", TODAY, WORKSPACE).explicitRouteMatched).toBe(false);
    expect(parseCapture("draft", TODAY, WORKSPACE).explicitRouteMatched).toBe(false);
  });

  it("uses the configured fallback for an untagged capture", () => {
    expect(parseCapture("buy groceries", TODAY, WORKSPACE).destination).toEqual({ sourceId: "inbox", heading: "Captured" });
  });

  it("anchors bare recurrence and preserves explicit anchors", () => {
    expect(parseCapture("publish every Sunday #writing", TODAY, WORKSPACE).due).toBe("2026-07-02");
    expect(parseCapture("publish every Sunday by Jul 5 #writing", TODAY, WORKSPACE).due).toBe("2026-07-05");
    expect(parseCapture("stretch daily", TODAY, WORKSPACE).recurrence).toBe("every day");
    expect(parseCapture("review weekly", TODAY, WORKSPACE).recurrence).toBe("every week");
  });

  it("protects edit titles that resemble grammar", () => {
    const task = makeTask({ title: "Explain why this says due Aug 21 #writing", tags: ["learning"], due: "2026-06-30", priority: "p2" });
    const parsed = parseCapture(taskToCaptureString(task), TODAY, WORKSPACE);
    expect(parsed.title).toBe(task.title);
    expect(parsed.tags).toEqual(task.tags);
    expect(parsed.due).toBe(task.due);
    expect(parsed.priority).toBe(task.priority);
  });

  it("round-trips owner metadata through the edit grammar", () => {
    const task = makeTask({ title: "Review", owner: "alex-smith" });
    expect(parseCapture(taskToCaptureString(task), TODAY, WORKSPACE).owner).toBe("alex-smith");
  });

  it.each([
    [{ due: "2026-07-04", scheduled: "2026-07-03" }, { due: "2026-07-04" }, { due: "2026-07-04", scheduled: "2026-07-03" }],
    [{ due: "2026-07-04", scheduled: "2026-07-03" }, { due: "2026-07-05" }, { due: "2026-07-05", scheduled: "2026-07-03" }],
    [{ due: "2026-07-04" }, { due: "2026-07-05" }, { due: "2026-07-05", scheduled: undefined }],
    [{ scheduled: "2026-07-03" }, { scheduled: "2026-07-05" }, { due: undefined, scheduled: "2026-07-05" }],
  ])("merges the represented edit date without dropping its counterpart", (original, parsedDates, expected) => {
    const task = makeTask({ title: "Dated", ...original });
    const parsed = { ...parseCapture("Dated", TODAY, WORKSPACE), ...parsedDates };
    expect(mergeEditDates(task, parsed)).toEqual(expected);
  });
});

describe("capture suggestions and edit policy", () => {
  it("offers configured route aliases and filters", () => {
    expect(knownCaptureTags(WORKSPACE)).toEqual(["writing", "write", "learning", "study", "shared", "automated"]);
  });

  it("suggests the first configured keyword and never overrides an explicit tag", () => {
    expect(suggestArea("draft an article", WORKSPACE)).toEqual({ tag: "writing", matchedWord: "article" });
    expect(suggestArea("draft an article #learning", WORKSPACE)).toBeNull();
    expect(suggestArea("unrelated errand", WORKSPACE)).toBeNull();
  });

  it("pins stay-policy sources to their current source and heading", () => {
    const task = makeTask({ sourceId: "team", filePath: "Shared/Tasks.md", heading: "Platform", title: "Review handoff" });
    const parsed = parseCapture("Review handoff #writing", TODAY, WORKSPACE);
    expect(resolveEditDestination(task, parsed, WORKSPACE)).toEqual({ sourceId: "team", heading: "Platform" });
  });

  it("routes edit-policy sources and keeps an unrouted task in place when no fallback exists", () => {
    const task = makeTask({ title: "Review notes", heading: "Learning" });
    const parsed = parseCapture("Review notes #writing", TODAY, WORKSPACE);
    expect(resolveEditDestination(task, parsed, WORKSPACE)).toEqual({ sourceId: "tasks", heading: "Writing" });
  });

  it("keeps route-policy edits in place when only fallback routing is available", () => {
    const task = makeTask({ title: "Review notes", heading: "Learning" });
    const parsed = parseCapture(taskToCaptureString(task), TODAY, WORKSPACE);
    expect(parsed.destination).toEqual({ sourceId: "inbox", heading: "Captured" });
    expect(parsed.explicitRouteMatched).toBe(false);
    expect(resolveEditDestination(task, parsed, WORKSPACE)).toEqual({ sourceId: "tasks", heading: "Learning" });
  });
});

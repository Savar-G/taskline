import { describe, expect, it } from "vitest";
import { serializeTask } from "../src/format";
import { parseProposalLine, parseTaskLine, parseTrackerFile } from "../src/parser";
import { WORKSPACE } from "./fixtures";

const ctx = (over: Partial<{ sourceId: string; filePath: string; lineNo: number; heading: string }> = {}) => ({
  sourceId: "tasks",
  filePath: "Tasks.md",
  lineNo: 1,
  heading: "Writing",
  ...over,
});

describe("parseTaskLine", () => {
  it("parses tags, provenance, and non-provenance parentheses", () => {
    const line = "- [ ] Test device flow (phase 2) #writing (from [[Build Log]])";
    const task = parseTaskLine(line, ctx());
    expect(task).toMatchObject({ title: "Test device flow (phase 2)", tags: ["writing"], sourceId: "tasks" });
    expect(task?.provenance).toEqual({ kind: "link", source: "[[Build Log]]" });
    expect(serializeTask(task!)).toBe(line);
  });

  it("round-trips generic slash/hyphen tags and hyphenated owners", () => {
    const line = "- [ ] Review #client/work-stream #follow-up — @alex-smith";
    const task = parseTaskLine(line, ctx())!;
    expect(task.tags).toEqual(["client/work-stream", "follow-up"]);
    expect(task.owner).toBe("alex-smith");
    expect(serializeTask(task)).toBe(line);
  });

  it("parses recurrence, priorities, dates, owner, and stale state", () => {
    const line = "- [/] Publish update #writing (from inbox 2026-06-26) — @Alex 🟡 stale 5d 🔼 🔁 every week ⏳ 2026-07-01 📅 2026-07-02";
    const task = parseTaskLine(line, ctx());
    expect(task).toMatchObject({
      status: "in-progress",
      priority: "p3",
      scheduled: "2026-07-01",
      due: "2026-07-02",
      recurrence: "every week",
      owner: "Alex",
      stale: { level: "warn", days: 5 },
    });
    expect(serializeTask(task!)).toBe(line);
  });

  it("parses done and cancelled states plus their dates", () => {
    expect(parseTaskLine("- [x] Finished ✅ 2026-07-01", ctx())).toMatchObject({ status: "done", doneDate: "2026-07-01" });
    expect(parseTaskLine("- [-] Dropped ❌ 2026-07-01", ctx())).toMatchObject({ status: "cancelled", cancelledDate: "2026-07-01" });
  });

  it("normalizes legacy timed signifiers to Taskline's date-only model", () => {
    expect(parseTaskLine("- [ ] Legacy ⏳ 2026-07-01T09:30 📅 2026-07-02T14:00", ctx()))
      .toMatchObject({ scheduled: "2026-07-01", due: "2026-07-02" });
  });

  it("round-trips an alert stale marker and preserves an em dash in provenance", () => {
    const line = "- [ ] Escalate review (from [[May 1 — Review]]) — @Alex 🔴 stale 46d (escalate)";
    const task = parseTaskLine(line, ctx())!;
    expect(task.stale).toEqual({ level: "alert", days: 46 });
    expect(task.provenance?.source).toBe("[[May 1 — Review]]");
    expect(serializeTask(task)).toBe(line);
  });

  it("handles every open status char", () => {
    expect(parseTaskLine("- [ ] Todo", ctx())?.status).toBe("todo");
    expect(parseTaskLine("- [!] Blocked", ctx())?.status).toBe("blocked");
    expect(parseTaskLine("- [?] Planning", ctx())?.status).toBe("planning");
  });

  it("tolerates malformed and non-task input", () => {
    for (const input of ["", "random", "## Heading", null as unknown as string]) {
      expect(() => parseTaskLine(input, ctx())).not.toThrow();
    }
    expect(parseTaskLine("random", ctx())).toBeNull();
  });
});

describe("proposals and tracker files", () => {
  it("parses proposal evidence and source", () => {
    const proposal = parseProposalLine('- (propose done) Review draft - evidence: "approved" [[Meeting]]', ctx());
    expect(proposal).toMatchObject({ sourceId: "tasks", action: "complete", text: "Review draft", evidence: "approved", source: "Meeting" });
  });

  it("parses proposals without evidence and rejects ordinary bullets", () => {
    expect(parseProposalLine("- (propose cancel) Drop stale idea", ctx())).toMatchObject({ action: "cancel", text: "Drop stale idea" });
    expect(parseProposalLine("- [ ] Ordinary task", ctx())).toBeNull();
  });

  it.each([
    ["done", "complete"],
    ["complete", "complete"],
    ["cancel", "cancel"],
  ] as const)("normalizes proposal action %s", (input, action) => {
    expect(parseProposalLine(`- (propose ${input}) Task`, ctx())?.action).toBe(action);
  });

  it.each(["finish", "done later", "", "delete"])("rejects unsupported proposal action %j", (action) => {
    expect(parseProposalLine(`- (propose ${action}) Task`, ctx())).toBeNull();
  });

  it("tracks headings, subnotes, source identity, and enabled proposals", () => {
    const content = [
      "## Writing",
      "- [ ] Draft article #writing",
      "  - 📝 Waiting for review",
      "## Learning",
      "- [x] Finish course #learning ✅ 2026-07-01",
      "## Proposed",
      "- (propose done) Archive notes",
    ].join("\n");
    const source = WORKSPACE.sourceById.get("tasks")!;
    const result = parseTrackerFile(content, source, WORKSPACE);
    expect(result.tasks.map((task) => task.heading)).toEqual(["Writing", "Learning"]);
    expect(result.tasks[0].subNotes).toEqual(["Waiting for review"]);
    expect(result.proposals).toHaveLength(1);
  });

  it("ignores proposals for a source that disables them", () => {
    const source = WORKSPACE.sourceById.get("team")!;
    expect(parseTrackerFile("- (propose done) Archive notes", source, WORKSPACE).proposals).toEqual([]);
  });

  it("does not throw on malformed tracker content", () => {
    const source = WORKSPACE.sourceById.get("tasks")!;
    expect(() => parseTrackerFile("\0 garbage\n- [", source, WORKSPACE)).not.toThrow();
    expect(() => parseTrackerFile(null as unknown as string, source, WORKSPACE)).not.toThrow();
  });
});

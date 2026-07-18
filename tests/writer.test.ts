import { describe, expect, it } from "vitest";
import {
  appendUnderHeadingText,
  appendBlockText,
  applyProposalText,
  assertSameFileProposal,
  blockLength,
  cancelLine,
  completeLine,
  editLineText,
  moveTaskWithinText,
  rollbackInsertedBlockText,
  removeTaskBlockText,
  runCrossFileMove,
  VtCrossFileProposalError,
  VtPartialMoveError,
  VtRecurrenceUnavailableError,
  VtStaleError,
} from "../src/writerCore";
import { makeTask } from "./fixtures";

describe("atomic text mutations", () => {
  it("validates the exact stale line inside the mutation", () => {
    expect(() => editLineText("## Tasks\n- [ ] Changed", { rawLine: "- [ ] Original", lineNo: 2 }, () => "- [x] Original"))
      .toThrow(VtStaleError);
  });

  it("always appends a destination block and preserves CRLF", () => {
    const content = "## Tasks\r\n- [ ] Existing\r\n";
    const block = ["- [ ] Moved", "  - 📝 Detail"];
    const first = appendBlockText(content, "Tasks", block);
    const second = appendBlockText(first.content, "Tasks", block);
    expect(second.content.match(/- \[ \] Moved/g)).toHaveLength(2);
    expect(first.content).toContain("\r\n- [ ] Moved\r\n  - 📝 Detail");
  });

  it("rolls back exactly the insertion identified by its operation receipt", () => {
    const original = "## Tasks\n- [ ] Moved";
    const appended = appendBlockText(original, "Tasks", ["- [ ] Moved"]);
    expect(rollbackInsertedBlockText(appended.content, appended.receipt)).toBe(original);
    expect(() => rollbackInsertedBlockText("## Tasks\n- [ ] Moved\n- [ ] Changed", appended.receipt))
      .toThrow(VtStaleError);
  });

  it("atomically completes a same-file target and removes its proposal", () => {
    const task = makeTask({ title: "Review", rawLine: "- [ ] Review", lineNo: 2 });
    const proposal = {
      sourceId: "tasks", filePath: "Tasks.md", lineNo: 3,
      rawLine: "- (propose done) Review", action: "complete" as const, text: "Review",
    };
    const result = applyProposalText("## Tasks\n- [ ] Review\n- (propose done) Review", proposal, task, null);
    expect(result).toMatch(/^## Tasks\n- \[x\] Review \(reconciled from proposal\) ✅ \d{4}-\d{2}-\d{2}$/);
  });

  it("atomically cancels a same-file target and removes its proposal", () => {
    const task = makeTask({ title: "Drop", rawLine: "- [ ] Drop", lineNo: 2 });
    const proposal = {
      sourceId: "tasks", filePath: "Tasks.md", lineNo: 3,
      rawLine: "- (propose cancel) Drop", action: "cancel" as const, text: "Drop", source: "Review",
    };
    const result = applyProposalText("## Tasks\n- [ ] Drop\n- (propose cancel) Drop", proposal, task, null);
    expect(result).toMatch(/^## Tasks\n- \[-\] Drop \(reconciled from Review\) ❌ \d{4}-\d{2}-\d{2}$/);
  });

  it("serializes cancellation without completion semantics", () => {
    expect(cancelLine(makeTask({ title: "Drop" }), "- [ ] Drop")).toMatch(/^- \[-\] Drop ❌ \d{4}-\d{2}-\d{2}$/);
  });

  it("preserves CRLF while editing and appending", () => {
    const edited = editLineText("## Tasks\r\n- [ ] Original\r\n", { rawLine: "- [ ] Original", lineNo: 2 }, () => "- [x] Original");
    expect(edited).toBe("## Tasks\r\n- [x] Original\r\n");
    expect(appendUnderHeadingText(edited, "Tasks", ["- [ ] Added"])).toBe("## Tasks\r\n- [x] Original\r\n\r\n- [ ] Added");
  });

  it("moves a task and its subnotes within one text transaction", () => {
    const content = ["## First", "- [ ] Move me", "  - 📝 Detail", "## Second", "- [ ] Existing"].join("\n");
    const task = makeTask({ rawLine: "- [ ] Move me", lineNo: 2, heading: "First", title: "Move me" });
    expect(moveTaskWithinText(content, task, "- [ ] Moved", "Second")).toBe(
      ["## First", "## Second", "- [ ] Existing", "- [ ] Moved", "  - 📝 Detail"].join("\n")
    );
  });

  it("moves every consecutive deeper-indented child line and stops at top-level boundaries", () => {
    const lines = [
      "## First",
      "- [ ] Parent",
      "  - [ ] Nested task",
      "    continuation text",
      "  %% comment %%",
      "  ![[embed]]",
      "- [ ] Next task",
      "## Second",
    ];
    expect(blockLength(lines, 1)).toBe(5);
    const moved = moveTaskWithinText(lines.join("\n"), makeTask({
      title: "Parent", rawLine: "- [ ] Parent", lineNo: 2, heading: "First",
    }), "- [ ] Parent", "Second");
    expect(moved).toContain("- [ ] Next task\n## Second\n- [ ] Parent\n  - [ ] Nested task\n    continuation text\n  %% comment %%\n  ![[embed]]");
  });

  it("stops a moved block at a blank line even when later text is indented", () => {
    expect(blockLength(["- [ ] Parent", "  child", "", "  unrelated"], 0)).toBe(2);
  });

  it("refuses to remove a source block whose indented children changed after append", () => {
    const task = makeTask({ title: "Parent", rawLine: "- [ ] Parent", lineNo: 2 });
    expect(() => removeTaskBlockText(
      "## Tasks\n- [ ] Parent\n  changed",
      task,
      ["- [ ] Parent", "  original"]
    )).toThrow(VtStaleError);
  });
});

describe("cross-file move transaction", () => {
  it("preserves cardinality when the destination already has an identical task", async () => {
    let source = "## Tasks\n- [ ] Same";
    let destination = "## Tasks\n- [ ] Same";
    await runCrossFileMove({
      appendDestination: async () => {
        const result = appendBlockText(destination, "Tasks", ["- [ ] Same"]);
        destination = result.content;
        return result.receipt;
      },
      removeSource: async () => {
        source = editLineText(source, { rawLine: "- [ ] Same", lineNo: 2 }, () => []);
      },
      rollbackDestination: async (receipt) => {
        destination = rollbackInsertedBlockText(destination, receipt);
      },
    });
    expect(source).toBe("## Tasks");
    expect(destination.match(/- \[ \] Same/g)).toHaveLength(2);
  });

  it("rolls back the inserted block when source removal fails", async () => {
    const original = "## Tasks\n- [ ] Existing";
    let destination = original;
    const sourceError = new Error("injected source failure");
    await expect(runCrossFileMove({
      appendDestination: async () => {
        const result = appendBlockText(destination, "Tasks", ["- [ ] Moved"]);
        destination = result.content;
        return result.receipt;
      },
      removeSource: async () => { throw sourceError; },
      rollbackDestination: async (receipt) => {
        destination = rollbackInsertedBlockText(destination, receipt);
      },
    })).rejects.toBe(sourceError);
    expect(destination).toBe(original);
  });

  it("throws a typed partial-move error with recovery instructions when rollback fails", async () => {
    const operation = runCrossFileMove({
      appendDestination: async () => ({ operation: "receipt" }),
      removeSource: async () => { throw new Error("injected source failure"); },
      rollbackDestination: async () => { throw new Error("injected rollback failure"); },
    });
    await expect(operation).rejects.toBeInstanceOf(VtPartialMoveError);
    await expect(operation).rejects.toMatchObject({
      recoveryInstructions: expect.stringContaining("both files"),
    });
  });
});

describe("proposal transaction boundary", () => {
  it.each(["complete", "cancel"] as const)("rejects a cross-file %s proposal before mutation", (action) => {
    const proposal = {
      filePath: "Proposals.md", rawLine: `- (propose ${action}) Exact`, action, text: "Exact",
    };
    const task = makeTask({ title: "Exact", filePath: "Tasks.md", rawLine: "- [ ] Exact" });
    expect(() => assertSameFileProposal(proposal, task)).toThrow(VtCrossFileProposalError);
    try {
      assertSameFileProposal(proposal, task);
    } catch (error) {
      expect((error as Error).message).toContain("Move the proposal to Tasks.md");
    }
  });

  it("allows same-file confirmation to continue to the exact atomic mutation", () => {
    expect(() => assertSameFileProposal({ filePath: "Tasks.md" }, { filePath: "Tasks.md" })).not.toThrow();
  });
});

describe("recurrence completion safety", () => {
  it("refuses recurring completion without the Tasks API", () => {
    const task = makeTask({ title: "Repeat", recurrence: "every day" });
    expect(() => completeLine(null, task, "- [ ] Repeat 🔁 every day 📅 2026-07-02"))
      .toThrow(VtRecurrenceUnavailableError);
  });

  it("keeps the non-recurring completion fallback", () => {
    const line = completeLine(null, makeTask({ title: "Once" }), "- [ ] Once");
    expect(line).toMatch(/^- \[x\] Once ✅ \d{4}-\d{2}-\d{2}$/);
  });

  it("accepts recurrence output produced by the Tasks API", () => {
    const task = makeTask({ title: "Repeat", recurrence: "every day" });
    const api = {
      executeToggleTaskDoneCommand: () => ["- [x] Repeat ✅ 2026-07-02", "- [ ] Repeat 🔁 every day 📅 2026-07-03"],
    };
    expect(completeLine(api, task, "- [ ] Repeat 🔁 every day 📅 2026-07-02")).toEqual([
      "- [x] Repeat ✅ 2026-07-02",
      "- [ ] Repeat 🔁 every day 📅 2026-07-03",
    ]);
  });
});

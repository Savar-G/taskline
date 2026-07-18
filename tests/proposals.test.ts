import { describe, expect, it } from "vitest";
import type { VtProposal } from "../src/model";
import { findProposalTarget, normalizeTaskIdentity } from "../src/proposals";
import { makeTask } from "./fixtures";

function proposal(text: string, action: VtProposal["action"] = "complete"): VtProposal {
  return {
    sourceId: "tasks",
    filePath: "Tasks.md",
    lineNo: 2,
    rawLine: `- (propose ${action}) ${text}`,
    action,
    text,
  };
}

describe("proposal identity", () => {
  it.each([
    [" Review   Draft ", "review draft"],
    ["REVIEW DRAFT", "review draft"],
    ["\tReview\nDraft", "review draft"],
  ])("normalizes whitespace and case in %j", (input, expected) => {
    expect(normalizeTaskIdentity(input)).toBe(expected);
  });

  it("matches one exact normalized open task", () => {
    const target = makeTask({ title: "Review   Draft" });
    expect(findProposalTarget(proposal(" review draft "), [target])).toBe(target);
  });

  it.each([
    ["Review", "Review draft"],
    ["Review draft", "Review"],
    ["draft", "Review draft"],
  ])("does not fuzzy-match %j against %j", (proposalText, taskTitle) => {
    expect(findProposalTarget(proposal(proposalText), [makeTask({ title: taskTitle })])).toBeNull();
  });

  it("rejects ambiguous exact matches", () => {
    expect(findProposalTarget(proposal("Same"), [makeTask({ title: "Same" }), makeTask({ title: "same" })])).toBeNull();
  });

  it("prefers the proposal's own file over an identical task in another source", () => {
    const local = makeTask({ title: "Same", filePath: "Tasks.md" });
    const remote = makeTask({ title: "Same", sourceId: "team", filePath: "Shared/Tasks.md" });
    expect(findProposalTarget(proposal("Same"), [remote, local])).toBe(local);
  });

  it("rejects ambiguous exact matches within the proposal's own file", () => {
    const first = makeTask({ title: "Same", filePath: "Tasks.md" });
    const second = makeTask({ title: "same", filePath: "Tasks.md" });
    expect(findProposalTarget(proposal("Same"), [first, second])).toBeNull();
  });

  it.each(["done", "cancelled"] as const)("does not target %s tasks", (status) => {
    expect(findProposalTarget(proposal("Closed"), [makeTask({
      title: "Closed",
      status,
      statusChar: status === "done" ? "x" : "-",
    })])).toBeNull();
  });
});

import { VtProposal } from "../model";

export interface ProposedRowHandlers {
  onConfirm(proposal: VtProposal, row: HTMLElement): void;
  onReject(proposal: VtProposal, row: HTMLElement): void;
}

/** Machine-suggested task awaiting human confirm. Reads as provisional per DESIGN section
 * 3.3: dashed ghost ring, reduced opacity, an evidence receipt line, inline confirm/reject. */
export function buildProposedRow(
  parent: HTMLElement,
  proposal: VtProposal,
  handlers: ProposedRowHandlers
): HTMLElement {
  const row = parent.createDiv({ cls: "vt-proposed-row vt-focusable" });
  row.dataset.kind = "proposal";
  row.setAttr("role", "listitem");

  const top = row.createDiv({ cls: "vt-proposed-top" });

  const ring = top.createDiv({ cls: "vt-ring vt-ring--ghost" });
  ring.setAttr("aria-hidden", "true");

  top.createSpan({ cls: "vt-proposed-title", text: proposal.text });

  const actions = top.createDiv({ cls: "vt-proposed-actions" });
  const confirm = actions.createEl("button", { cls: "vt-action vt-action--confirm", text: "✓" });
  confirm.setAttr("aria-label", `Confirm proposal: ${proposal.text}`);
  confirm.setAttr("type", "button");
  // Row-level Y/N keyboard already drives confirm/reject; these are not extra Tab stops.
  confirm.setAttr("tabindex", "-1");
  const reject = actions.createEl("button", { cls: "vt-action vt-action--reject", text: "✗" });
  reject.setAttr("aria-label", `Reject proposal: ${proposal.text}`);
  reject.setAttr("type", "button");
  reject.setAttr("tabindex", "-1");

  // Evidence receipt always renders: quote when present, else source-only attribution,
  // else an explicit "no evidence" note - never silently absent.
  const ev = row.createDiv({ cls: "vt-proposed-evidence" });
  ev.createSpan({ cls: "vt-evidence-arrow", text: "↳", attr: { "aria-hidden": "true" } });
  if (proposal.evidence) {
    ev.createSpan({ cls: "vt-evidence-quote", text: `"${proposal.evidence}"` });
    if (proposal.source) {
      ev.createSpan({ cls: "vt-evidence-source", text: `- ${proposal.source}` });
    }
  } else if (proposal.source) {
    ev.createSpan({ cls: "vt-evidence-source", text: proposal.source });
  } else {
    ev.createSpan({ cls: "vt-evidence-quote", text: "No evidence recorded" });
  }

  confirm.addEventListener("click", (e) => {
    e.stopPropagation();
    handlers.onConfirm(proposal, row);
  });
  reject.addEventListener("click", (e) => {
    e.stopPropagation();
    handlers.onReject(proposal, row);
  });

  return row;
}

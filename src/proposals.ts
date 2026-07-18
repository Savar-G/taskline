import type { VtProposal, VtTask } from "./model";

export function normalizeTaskIdentity(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function findProposalTarget(proposal: VtProposal, tasks: VtTask[]): VtTask | null {
  const identity = normalizeTaskIdentity(proposal.text);
  if (!identity) return null;
  const matches = tasks.filter((task) => (
    task.status !== "done"
    && task.status !== "cancelled"
    && normalizeTaskIdentity(task.title) === identity
  ));
  const localMatches = matches.filter((task) => task.filePath === proposal.filePath);
  if (localMatches.length > 0) return localMatches.length === 1 ? localMatches[0] : null;
  return matches.length === 1 ? matches[0] : null;
}

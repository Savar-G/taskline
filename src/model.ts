// Pure data model types shared across the plugin. No imports from 'obsidian' here -
// this module (and the other pure modules that depend on it) must be unit-testable in node.

export type VtStatus =
  | "todo"
  | "in-progress"
  | "blocked"
  | "planning"
  | "done"
  | "cancelled";

export type VtPriority = "p1" | "p2" | "p3" | "p4" | null;

export interface VtProvenance {
  kind: string;
  date?: string;
  source?: string;
}

export interface VtStale {
  level: "warn" | "alert";
  days: number;
}

export interface VtTask {
  sourceId: string;
  filePath: string;
  lineNo: number;
  rawLine: string;
  indent?: string;
  status: VtStatus;
  statusChar: string;
  title: string;
  tags: string[];
  priority: VtPriority;
  due?: string;
  scheduled?: string;
  doneDate?: string;
  cancelledDate?: string;
  recurrence?: string;
  provenance?: VtProvenance;
  owner?: string;
  stale?: VtStale;
  heading: string;
  subNotes: string[];
}

export interface VtProposal {
  sourceId: string;
  filePath: string;
  lineNo: number;
  rawLine: string;
  action: "complete" | "cancel";
  text: string;
  evidence?: string;
  source?: string;
}

// Maps the Tasks-plugin status char to our VtStatus enum. Unknown chars fall back to 'todo'.
export function statusCharToStatus(char: string): VtStatus {
  switch (char) {
    case " ":
      return "todo";
    case "/":
      return "in-progress";
    case "!":
      return "blocked";
    case "?":
      return "planning";
    case "x":
    case "X":
      return "done";
    case "-":
      return "cancelled";
    default:
      return "todo";
  }
}

export function statusToStatusChar(status: VtStatus): string {
  switch (status) {
    case "todo":
      return " ";
    case "in-progress":
      return "/";
    case "blocked":
      return "!";
    case "planning":
      return "?";
    case "done":
      return "x";
    case "cancelled":
      return "-";
  }
}

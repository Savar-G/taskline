import { parseCapture } from "./captureRules";
import type { RuntimeWorkspace } from "./settings";

export type EditablePriority = "p1" | "p2" | "p3" | "p4" | null;

export interface QuickDate {
  id: "today" | "tomorrow" | "next-week" | "next-weekend";
  label: string;
  iso: string;
}

function dateOnly(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = dateOnly(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function localIso(date: Date): string {
  const pad = (value: number) => (value < 10 ? `0${value}` : String(value));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseLocalIso(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function quickDates(today: Date): QuickDate[] {
  const current = dateOnly(today);
  const daysUntilMonday = (1 - current.getDay() + 7) % 7 || 7;
  const nextMonday = addDays(current, daysUntilMonday);
  return [
    { id: "today", label: "Today", iso: localIso(current) },
    { id: "tomorrow", label: "Tomorrow", iso: localIso(addDays(current, 1)) },
    { id: "next-week", label: "Next week", iso: localIso(nextMonday) },
    { id: "next-weekend", label: "Next weekend", iso: localIso(addDays(nextMonday, 5)) },
  ];
}

function replaceSpan(input: string, start: number, end: number, replacement: string): string {
  return `${input.slice(0, start)}${replacement}${input.slice(end)}`.replace(/\s+/g, " ").trim();
}

export function setCaptureDate(input: string, iso: string | null, today: Date, workspace: RuntimeWorkspace): string {
  const parsed = parseCapture(input, today, workspace);
  const token = parsed.tokens.find((item) => item.type === "date" || item.type === "scheduled");
  if (!iso) return token ? replaceSpan(input, token.start, token.end, "") : input.trim();

  const phrase = `${token?.type === "scheduled" ? "starting" : "by"} ${iso}`;
  return token ? replaceSpan(input, token.start, token.end, phrase) : `${input.trim()} ${phrase}`.trim();
}

const PRIORITY_GRAMMAR: Record<Exclude<EditablePriority, null>, string> = {
  p1: "priority:urgent",
  p2: "priority:high",
  p3: "priority:medium",
  p4: "priority:low",
};

export function setCapturePriority(input: string, priority: EditablePriority, today: Date, workspace: RuntimeWorkspace): string {
  const parsed = parseCapture(input, today, workspace);
  const token = parsed.tokens.find((item) => item.type === "priority");
  const grammar = priority ? PRIORITY_GRAMMAR[priority] : "";
  if (token) return replaceSpan(input, token.start, token.end, grammar);
  return grammar ? `${input.trim()} ${grammar}`.trim() : input.trim();
}

export function calendarDates(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

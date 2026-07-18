import { describe, expect, it } from "vitest";
import { insertAnnotation, relativeDateLabel, serializeTask, setStatusChar } from "../src/format";
import { parseTaskLine } from "../src/parser";

const ctx = { sourceId: "tasks", filePath: "Tasks.md", lineNo: 1, heading: "Writing" };

describe("line formatting", () => {
  it("sets status without disturbing other text", () => {
    expect(setStatusChar("- [ ] Task", "x")).toBe("- [x] Task");
    expect(setStatusChar("not a task", "x")).toBe("not a task");
  });

  it("inserts annotations before the complete signifier run", () => {
    expect(insertAnnotation("- [ ] Task 🔼 🔁 every week 📅 2026-07-01", "(note)")).toBe(
      "- [ ] Task (note) 🔼 🔁 every week 📅 2026-07-01"
    );
    expect(insertAnnotation("- [ ] Task", "(note)")).toBe("- [ ] Task (note)");
  });

  it("serializes metadata in canonical order and preserves generic tags", () => {
    const line = "- [ ] Everything #writing (from inbox 2026-06-01) — @Alex 🟡 stale 5d 🔺 🔁 every day ⏳ 2026-07-05 📅 2026-07-06";
    expect(serializeTask(parseTaskLine(line, ctx)!)).toBe(line);
  });

  it("preserves nested task indentation when serializing an edit", () => {
    const line = "    - [ ] Nested task #writing";
    const task = parseTaskLine(line, ctx)!;
    task.title = "Edited nested task";
    expect(serializeTask(task)).toBe("    - [ ] Edited nested task #writing");
  });
});

describe("relativeDateLabel", () => {
  const today = new Date(2026, 6, 2);

  it("labels nearby and distant dates", () => {
    expect(relativeDateLabel("2026-07-02", today)).toBe("Today");
    expect(relativeDateLabel("2026-07-03", today)).toBe("Tomorrow");
    expect(relativeDateLabel("2026-07-01", today)).toBe("Yesterday");
    expect(relativeDateLabel("2026-07-06", today)).toBe("Mon");
    expect(relativeDateLabel("2025-07-04", today)).toBe("Jul 4, 2025");
  });

  it.each(["2026-07-02T14:00", "2026-07-02T09:30", "2026-07-02T00:00"])(
    "ignores legacy time components because storage is date-only: %s",
    (iso) => expect(relativeDateLabel(iso, today)).toBe("Today")
  );
});

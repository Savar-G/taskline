import { describe, expect, it } from "vitest";
import {
  calendarDates,
  localIso,
  quickDates,
  setCaptureDate,
  setCapturePriority,
} from "../src/editProperties";
import { parseCapture } from "../src/captureRules";
import { WORKSPACE } from "./fixtures";

const FRIDAY = new Date(2026, 6, 17);

describe("quickDates", () => {
  it("matches the Todoist-style next week and next weekend semantics", () => {
    expect(quickDates(FRIDAY).map((option) => option.iso)).toEqual([
      "2026-07-17",
      "2026-07-18",
      "2026-07-20",
      "2026-07-25",
    ]);
  });
});

describe("edit grammar mutations", () => {
  it("replaces, adds, and clears due dates without changing the protected title", () => {
    const original = '"Explain why this says due Aug 21" #learning by 2026-07-17 !!';
    const moved = setCaptureDate(original, "2026-07-20", FRIDAY, WORKSPACE);
    expect(parseCapture(moved, FRIDAY, WORKSPACE).title).toBe("Explain why this says due Aug 21");
    expect(parseCapture(moved, FRIDAY, WORKSPACE).due).toBe("2026-07-20");
    expect(parseCapture(setCaptureDate(moved, null, FRIDAY, WORKSPACE), FRIDAY, WORKSPACE).due).toBeUndefined();
    expect(parseCapture(setCaptureDate('"Undated" #writing', "2026-07-18", FRIDAY, WORKSPACE), FRIDAY, WORKSPACE).due)
      .toBe("2026-07-18");
  });

  it("preserves scheduled semantics when changing an existing scheduled date", () => {
    const changed = setCaptureDate('"Start project" starting 2026-07-17', "2026-07-20", FRIDAY, WORKSPACE);
    const parsed = parseCapture(changed, FRIDAY, WORKSPACE);
    expect(parsed.scheduled).toBe("2026-07-20");
    expect(parsed.due).toBeUndefined();
  });

  it("sets every priority level and distinguishes low from none", () => {
    const original = '"Review task" #writing !!';
    for (const priority of ["p1", "p2", "p3", "p4"] as const) {
      const changed = setCapturePriority(original, priority, FRIDAY, WORKSPACE);
      expect(parseCapture(changed, FRIDAY, WORKSPACE).priority).toBe(priority);
    }
    expect(parseCapture(setCapturePriority(original, null, FRIDAY, WORKSPACE), FRIDAY, WORKSPACE).priority).toBeNull();
  });
});

describe("calendarDates", () => {
  it("returns a complete Sunday-first six-week grid", () => {
    const dates = calendarDates(new Date(2026, 6, 1));
    expect(dates).toHaveLength(42);
    expect(localIso(dates[0])).toBe("2026-06-28");
    expect(localIso(dates[41])).toBe("2026-08-08");
  });
});

import { describe, expect, it } from "vitest";
import { areaColor } from "../src/ui/areaColor";
import { WORKSPACE } from "./fixtures";

describe("areaColor", () => {
  it("uses configured area, group, route, and filter colors", () => {
    expect(areaColor("writing", WORKSPACE)).toBe("var(--color-pink)");
    expect(areaColor("Shared work", WORKSPACE)).toBe("var(--color-purple)");
    expect(areaColor("automated", WORKSPACE)).toBe("var(--color-green)");
  });

  it("gives unknown values a stable theme color", () => {
    expect(areaColor("Unknown")).toBe(areaColor("Unknown"));
    expect(areaColor("Unknown")).toMatch(/^var\(--color-[a-z]+\)$/);
  });
});

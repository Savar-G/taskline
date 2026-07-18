import { describe, expect, it } from "vitest";
import { LongPressClickGuard } from "../src/ui/longPress";

describe("LongPressClickGuard", () => {
  it("does not suppress ordinary clicks", () => {
    expect(new LongPressClickGuard().consumeClick()).toBe(false);
  });

  it("suppresses the one synthetic click following a long press", () => {
    const guard = new LongPressClickGuard();
    guard.fired();
    expect(guard.consumeClick()).toBe(true);
    expect(guard.consumeClick()).toBe(false);
  });

  it("coalesces repeated fired signals into one suppression", () => {
    const guard = new LongPressClickGuard();
    guard.fired();
    guard.fired();
    expect([guard.consumeClick(), guard.consumeClick()]).toEqual([true, false]);
  });
});

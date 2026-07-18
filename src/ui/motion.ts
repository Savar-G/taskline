// UI motion sequences. No 'obsidian' import - pure DOM + timers so the timings in DESIGN
// section 4 live in exactly one place. Every sequence has a prefers-reduced-motion branch
// that preserves the state change while dropping the travel.

export interface AnimToken {
  cancelled: boolean;
}

class AnimationCancelledError extends Error {
  constructor() {
    super("Taskline animation cancelled");
    this.name = "AnimationCancelledError";
  }
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function checkpoint(token?: AnimToken): void {
  if (token?.cancelled) throw new AnimationCancelledError();
}

export function isCancellation(err: unknown): boolean {
  return err instanceof AnimationCancelledError;
}

/** Collapses a row to zero height then resolves. One-shot max-height animation (allowed off
 * the typing path per DESIGN section 4). Reduced motion -> instant. */
async function collapseRow(row: HTMLElement, reduced: boolean): Promise<void> {
  if (reduced) {
    row.setCssStyles({ display: "none" });
    return;
  }
  const start = row.scrollHeight;
  row.setCssStyles({ maxHeight: `${start}px`, overflow: "hidden" });
  // Force reflow so the transition has a start value to animate from.
  void row.offsetHeight;
  row.classList.add("vt-collapsing");
  row.setCssStyles({ maxHeight: "0px", opacity: "0" });
  await sleep(160);
}

/** Completion path: check draw -> flash -> fade+strike -> collapse (~680ms). Throws the
 * cancellation sentinel if the token is tripped mid-sequence (write failed -> caller reverts). */
export async function animateComplete(row: HTMLElement, token: AnimToken): Promise<void> {
  const ring = row.querySelector(".vt-ring");
  ring?.setAttribute("aria-checked", "true");

  if (prefersReducedMotion()) {
    row.classList.add("vt-completing", "vt-reduced");
    await sleep(400);
    checkpoint(token);
    await collapseRow(row, true);
    return;
  }

  row.classList.add("vt-completing");
  await sleep(180);
  checkpoint(token);

  row.classList.add("vt-check-flash");
  await sleep(140);
  checkpoint(token);

  row.classList.add("vt-fading");
  await sleep(200);
  checkpoint(token);

  await collapseRow(row, false);
}

/** Proposed reject: fade + collapse, no strike (160ms). */
export async function animateReject(row: HTMLElement): Promise<void> {
  const reduced = prefersReducedMotion();
  row.classList.add("vt-rejecting");
  if (reduced) {
    await collapseRow(row, true);
    return;
  }
  await collapseRow(row, false);
}

/** Proposed confirm: ghost -> solid (~200ms) then collapse out, since confirming completes
 * the matched task and removes the proposal line. */
export async function animateConfirm(row: HTMLElement): Promise<void> {
  const reduced = prefersReducedMotion();
  row.classList.add("vt-confirming");
  if (reduced) {
    await collapseRow(row, true);
    return;
  }
  await sleep(200);
  await collapseRow(row, false);
}

/** Undoes the visual side effects of a failed optimistic action, restoring the row so the
 * user can retry. Idempotent. */
export function revertRow(row: HTMLElement): void {
  row.classList.remove(
    "vt-completing",
    "vt-check-flash",
    "vt-fading",
    "vt-collapsing",
    "vt-rejecting",
    "vt-confirming",
    "vt-reduced"
  );
  row.setCssStyles({ maxHeight: "", overflow: "", opacity: "", display: "" });
  const ring = row.querySelector(".vt-ring");
  ring?.setAttribute("aria-checked", "false");
}

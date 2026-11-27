// Where a tap came from (Higani: « on se perd au clic »). What opens from
// a button grows out of it and closes back into it; once closed, that
// button is focused again and marked, so the eye finds where it was.

/** The button or link that was just used: focused, or last pressed. */
export function triggerOf(pressed: HTMLElement | null): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches("button, a"))
    return active;
  return pressed?.isConnected ? pressed : null;
}

/** A clip-path inset matching `box` on the screen (the start of a grow). */
export function insetOf(box: DOMRect, radius = 16) {
  return `inset(${box.top}px ${innerWidth - box.right}px ${innerHeight - box.bottom}px ${box.left}px round ${radius}px)`;
}

export const FULL_INSET = "inset(0px 0px 0px 0px round 0px)";

/** A circle from the middle of `box`, closed (0) or covering the screen. */
export function circleOf(box: DOMRect, open: boolean) {
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const reach = Math.hypot(
    Math.max(x, innerWidth - x),
    Math.max(y, innerHeight - y),
  );
  return `circle(${open ? Math.ceil(reach) : 0}px at ${x}px ${y}px)`;
}

/** Back on the button it came from: focused, and a ring that says « here ». */
export function markReturn(trigger: HTMLElement | null) {
  if (!trigger?.isConnected) return;
  trigger.focus({ preventScroll: true });
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  trigger.animate(
    [
      {
        boxShadow: "0 0 0 0 color-mix(in srgb, currentColor 60%, transparent)",
      },
      { boxShadow: "0 0 0 12px transparent" },
    ],
    { duration: 650, iterations: 2, easing: "ease-out" },
  );
}

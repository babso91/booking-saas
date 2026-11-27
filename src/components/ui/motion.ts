"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

// Shared motion (Higani: « qu'on ne se perde nulle part »): every change of
// place, choice or size shows where it comes from and where it goes. Each
// helper does nothing when motion is reduced.

const reduced = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** This helper's own animations still running on `el` (jsdom has none). */
const flying = (el: HTMLElement, id: string) =>
  typeof el.getAnimations === "function"
    ? el.getAnimations().filter((a) => a.id === id)
    : [];

/**
 * Whether a value moved back (before its previous value in `order`, or
 * smaller when no order is given): a slide then comes from the left.
 */
export function useBackward<T>(value: T, order?: readonly T[]) {
  const [seen, setSeen] = useState({ value, back: false });
  if (seen.value !== value) {
    const back = order
      ? order.indexOf(value) < order.indexOf(seen.value)
      : value < seen.value;
    setSeen({ value, back });
  }
  return seen.back;
}

/** The slide class for a change of place: forward or back. */
export const slideClass = (back: boolean) =>
  back
    ? "motion-safe:animate-step-in-back"
    : "motion-safe:animate-step-in-forward";

/**
 * A pill that goes from the previous choice to the new one by stretching
 * towards it, its leading edge first, then landing (squash and stretch:
 * soft, not stiff). Put `container` on a positioned parent and render
 * `<span ref={pill}>` in it; it covers the `[aria-pressed="true"]` child.
 * `reveal` keeps that child in view inside a scrolling row.
 */
export function useTravelPill<T extends HTMLElement>(
  key: unknown,
  { reveal = false }: { reveal?: boolean } = {},
) {
  const container = useRef<T>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const last = useRef<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const box = container.current;
    const span = pill.current;
    if (!box || !span) return;
    const place = (animate: boolean) => {
      const on = box.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (!on) {
        span.style.opacity = "0";
        last.current = null;
        return;
      }
      const to = {
        x: on.offsetLeft,
        y: on.offsetTop,
        w: on.offsetWidth,
        h: on.offsetHeight,
      };
      let from = last.current;
      const midway = animate ? flying(span, "travel-pill") : [];
      if (midway.length) {
        // Tapped again before it landed: it leaves from where it is now.
        const now = getComputedStyle(span);
        const [x, y = 0] = now.translate.split(" ").map(parseFloat);
        if (x !== undefined && !Number.isNaN(x))
          from = { x, y, w: parseFloat(now.width), h: parseFloat(now.height) };
        for (const a of midway) a.cancel();
      }
      last.current = to;
      Object.assign(span.style, {
        opacity: "1",
        translate: `${to.x}px ${to.y}px`,
        width: `${to.w}px`,
        height: `${to.h}px`,
      });
      if (reveal) on.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (
        !animate ||
        !from ||
        reduced() ||
        (from.x === to.x && from.y === to.y)
      )
        return;
      const at = (x: number, y: number, w: number, h: number) => ({
        translate: `${x}px ${y}px`,
        width: `${w}px`,
        height: `${h}px`,
      });
      // Along one row: stretch to cover both, then let the trailing edge
      // catch up. Across rows: a plain glide.
      const frames =
        Math.abs(from.y + from.h / 2 - (to.y + to.h / 2)) < 1
          ? to.x > from.x
            ? [
                at(from.x, from.y, from.w, from.h),
                {
                  ...at(
                    from.x,
                    to.y + to.h * 0.06,
                    to.x + to.w - from.x,
                    to.h * 0.88,
                  ),
                  offset: 0.45,
                },
                at(to.x, to.y, to.w, to.h),
              ]
            : [
                at(from.x, from.y, from.w, from.h),
                {
                  ...at(
                    to.x,
                    to.y + to.h * 0.06,
                    from.x + from.w - to.x,
                    to.h * 0.88,
                  ),
                  offset: 0.45,
                },
                at(to.x, to.y, to.w, to.h),
              ]
          : [at(from.x, from.y, from.w, from.h), at(to.x, to.y, to.w, to.h)];
      span.animate(frames, { duration: 420, easing: EASE, id: "travel-pill" });
    };
    place(true);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => place(false));
    watch.observe(box);
    return () => watch.disconnect();
  }, [key, reveal]);
  return { container, pill };
}

/** The pill's own classes (its colour and shape are the caller's). */
export const PILL_CLASS = "pointer-events-none absolute top-0 left-0 opacity-0";

/**
 * Items brought in one after another, not all at once: the style for the
 * `index`-th one (a short cascade, capped so a long list is not slow).
 */
export const cascade = (index: number) =>
  ({ animationDelay: `${Math.min(index, 12) * 28}ms` }) as const;

/**
 * Height eased when `key` changes (« Lire la suite », a form that grows):
 * the box goes from its previous height to its new one, nothing jumps.
 */
export function useHeightTween(
  ref: RefObject<HTMLElement | null>,
  key: unknown,
) {
  const last = useRef<{ key: unknown; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const before = last.current;
    const changed = before !== null && before.key !== key;
    const midway = flying(el, "height-tween");
    if (!changed && midway.length) return; // a render mid-way: let it finish
    // Toggled again before it ended: it goes on from its height right now.
    const start = midway.length ? el.offsetHeight : before?.height;
    for (const a of midway) a.cancel();
    const height = el.offsetHeight;
    last.current = { key, height };
    if (!changed || start === height || reduced()) return;
    el.animate(
      [
        { height: `${start}px`, overflow: "hidden" },
        { height: `${height}px`, overflow: "hidden" },
      ],
      { duration: 260, easing: EASE, id: "height-tween" },
    );
  });
}

/**
 * A card carried from one screen to the next (the tapped service becomes
 * the next step's summary, and back): `carryFrom` remembers where it was,
 * the element marked `useCarryTo` with the same key flies from there.
 */
let carried: { key: string; box: DOMRect; at: number } | null = null;

export function carryFrom(key: string, from: Element | null) {
  carried = from
    ? { key, box: from.getBoundingClientRect(), at: performance.now() }
    : null;
}

/** Whether a card is on its way (its screen then fades, without sliding). */
export const carrying = () =>
  carried !== null && performance.now() - carried.at < 1200;

export function useCarryTo(
  key: string,
  ref: RefObject<HTMLElement | null>,
  { reveal = false }: { reveal?: boolean } = {},
) {
  useLayoutEffect(() => {
    const el = ref.current;
    const from = carried;
    if (!el || !from || from.key !== key || !carrying()) return;
    // Measured once the screen has settled (its scroll and focus moves);
    // used up then, so a development double run still flies once.
    el.style.opacity = "0";
    const frame = requestAnimationFrame(() => {
      carried = null;
      el.style.opacity = "";
      if (reveal) el.scrollIntoView({ block: "center" });
      if (reduced()) return;
      const to = el.getBoundingClientRect();
      el.animate(
        [
          {
            transformOrigin: "top left",
            transform: `translate(${from.box.left - to.left}px, ${from.box.top - to.top}px) scale(${from.box.width / to.width}, ${from.box.height / to.height})`,
          },
          { transformOrigin: "top left", transform: "none" },
        ],
        { duration: 380, easing: EASE },
      );
    });
    return () => {
      cancelAnimationFrame(frame);
      el.style.opacity = "";
    };
  }, [key, ref, reveal]);
}

/**
 * Items that change places glide to their new place (sections reordered
 * with ↑ ↓): mark each `data-flip="<id>"` inside `container`.
 */
export function useFlip(
  container: RefObject<HTMLElement | null>,
  key: unknown,
) {
  const last = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const box = container.current;
    if (!box) return;
    const before = last.current;
    const now = new Map<string, { x: number; y: number }>();
    for (const el of box.querySelectorAll<HTMLElement>("[data-flip]")) {
      const id = el.dataset.flip!;
      const at = { x: el.offsetLeft, y: el.offsetTop };
      now.set(id, at);
      const was = before.get(id);
      if (!was || reduced() || (was.x === at.x && was.y === at.y)) continue;
      el.animate(
        [
          { transform: `translate(${was.x - at.x}px, ${was.y - at.y}px)` },
          { transform: "none" },
        ],
        { duration: 300, easing: EASE },
      );
    }
    last.current = now;
  }, [container, key]);
}

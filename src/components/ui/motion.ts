"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

// Shared motion (Higani: « qu'on ne se perde nulle part »): every change of
// place, choice or size shows where it comes from and where it goes. Each
// helper does nothing when motion is reduced.

const reduced = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

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
 * A pill that travels from the previous choice to the new one: put
 * `container` on a positioned parent and render `<span ref={pill}>` in
 * it; it covers the `[aria-pressed="true"]` child, moving by CSS.
 */
export function useTravelPill<T extends HTMLElement>(key: unknown) {
  const container = useRef<T>(null);
  const pill = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const box = container.current;
    const span = pill.current;
    if (!box || !span) return;
    const place = (animate: boolean) => {
      const on = box.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (!on) {
        span.style.opacity = "0";
        return;
      }
      const jump = !animate || span.style.opacity !== "1";
      if (jump) span.style.transition = "none";
      span.style.opacity = "1";
      span.style.translate = `${on.offsetLeft}px ${on.offsetTop}px`;
      span.style.width = `${on.offsetWidth}px`;
      span.style.height = `${on.offsetHeight}px`;
      if (jump) {
        void span.offsetWidth;
        span.style.transition = "";
      }
    };
    place(true);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => place(false));
    watch.observe(box);
    return () => watch.disconnect();
  }, [key]);
  return { container, pill };
}

/** The pill's own classes (its colour and shape are the caller's). */
export const PILL_CLASS =
  "pointer-events-none absolute top-0 left-0 opacity-0 transition-[translate,width,height] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none";

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
    const height = el.offsetHeight;
    const before = last.current;
    last.current = { key, height };
    if (!before || before.key === key || before.height === height || reduced())
      return;
    el.animate(
      [
        { height: `${before.height}px`, overflow: "hidden" },
        { height: `${height}px`, overflow: "hidden" },
      ],
      { duration: 260, easing: EASE },
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

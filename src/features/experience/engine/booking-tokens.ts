import type { CSSProperties } from "react";

import type { Palette, ShapeId } from "./config";
import {
  cardOnPaper,
  contrast,
  ctaColors,
  inkOn,
  readableOn,
  readableTone,
  shapes,
  softOnPaper,
  towards,
} from "./tokens";

/**
 * The booking's own tokens (globals.css: --paper, --ink, --pop…) set from
 * her universe, so the real booking steps and the ticket render in her
 * colours and her type, not the app's. Same flow, same components: only
 * the variables change, on the booking's root (Tailwind's theme is inline,
 * the utilities read these at the element).
 *
 * The universe's day surface (`paper`, meant for services and booking) is
 * the ground; cards are lifted from it; every text colour is resolved on
 * the surface it sits on (4.5:1). The one loud colour is her booking
 * colour (`cta`) or her accent; a fill that would vanish on the ground
 * falls back to her ink.
 */
export function bookingTokens(tokens: {
  palette: Palette;
  cta?: string;
  shape?: ShapeId;
}): CSSProperties {
  const p = tokens.palette;
  // Her corners: the booking's radius scale capped by her shape (Net: all
  // square), the app's own scale otherwise.
  const radius = shapes[tokens.shape ?? "soft"].radius;
  const corner = (cap: number) => `${Math.min(radius, cap)}px`;
  const card = cardOnPaper(p);
  // One ink and one soft ink that read on the ground AND on the cards.
  const ink = inkOn(p.paper, inkOn(card, p.inkOnPaper));
  const soft = readableTone(
    readableTone(softOnPaper(p), card, ink),
    p.paper,
    ink,
  );

  const cta = ctaColors(tokens, p.accent);
  const visible = contrast(cta.fill, p.paper) >= 1.6;
  const pop = visible ? cta.fill : ink;
  const onPop = visible ? cta.text : readableOn(ink, [p.paper, "#FFFFFF"]);

  return {
    "--paper": p.paper,
    "--paper-raised": card,
    "--sand": towards(p.paper, ink, 0.08),
    "--sand-deep": towards(p.paper, ink, 0.14),
    "--line": towards(p.paper, ink, 0.16),
    "--line-strong": towards(p.paper, ink, 0.4),
    "--ink": ink,
    "--ink-soft": soft,
    "--ink-muted": soft,
    "--accent": pop,
    "--accent-strong": ink,
    "--accent-soft": towards(p.paper, pop, 0.14),
    "--signature": ink,
    "--on-signature": p.paper,
    "--pop": pop,
    "--on-pop": onPop,
    "--pop-hover": towards(pop, ink, 0.12),
    "--mark": pop,
    "--on-mark": onPop,
    "--radius-lg": corner(8),
    "--radius-xl": corner(12),
    "--radius-2xl": corner(16),
    "--radius-3xl": corner(24),
    "--font-sans": "var(--t-body)",
    fontFamily: "var(--t-body)",
    color: ink,
    background: p.paper,
  } as CSSProperties;
}

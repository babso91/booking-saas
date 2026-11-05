import {
  Big_Shoulders,
  Bodoni_Moda,
  DM_Mono,
  Figtree,
  Geist,
  Inter_Tight,
  Manrope,
  Newsreader,
  Space_Mono,
} from "next/font/google";

// The faces of our universes (engine/tokens.ts names them by variable).
// Declared together (Signature mixes type pairs), none preloaded: a page
// downloads only the faces it shows (2 or 3 files), never in front of the
// opening photo. Same set as the Experience Engine lab.

const milaDisplay = Bodoni_Moda({
  subsets: ["latin"],
  variable: "--font-mila-display",
  display: "swap",
  preload: false,
});
const milaBody = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-mila-body",
  display: "swap",
  preload: false,
});
const milaMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-mila-mono",
  display: "swap",
  preload: false,
});
const almaDisplay = Newsreader({
  subsets: ["latin"],
  weight: ["300", "400"],
  variable: "--font-alma-display",
  display: "swap",
  preload: false,
});
const almaBody = Figtree({
  subsets: ["latin"],
  variable: "--font-alma-body",
  display: "swap",
  preload: false,
});
const nailDisplay = Big_Shoulders({
  subsets: ["latin"],
  weight: ["700", "800", "900"],
  variable: "--font-nail-display",
  display: "swap",
  preload: false,
  // Next has no fallback metrics for this face: none rather than a warning.
  adjustFontFallback: false,
});
const nailBody = Manrope({
  subsets: ["latin"],
  variable: "--font-nail-body",
  display: "swap",
  preload: false,
});
const nailMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-nail-mono",
  display: "swap",
  preload: false,
});
const siteSans = Geist({
  subsets: ["latin"],
  variable: "--font-site-sans",
  display: "swap",
  preload: false,
});

/** The classes that declare every face, for a site's root. */
export const siteFontClasses = [
  milaDisplay,
  milaBody,
  milaMono,
  almaDisplay,
  almaBody,
  nailDisplay,
  nailBody,
  nailMono,
  siteSans,
]
  .map((font) => font.variable)
  .join(" ");

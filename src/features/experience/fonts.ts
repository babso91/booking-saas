import localFont from "next/font/local";

// The faces of our universes (engine/tokens.ts names them by variable).
// Declared together (Signature mixes type pairs), none preloaded: a page
// downloads only the faces it shows (2 or 3 files), never in front of the
// opening photo. Same set as the Experience Engine lab.
//
// Self-hosted (src/fonts, see its README), as the app's: the build never
// depends on a font service. Each face is two files, latin and latin-ext,
// under one family name with Google Fonts' unicode-ranges: a page downloads
// latin-ext only when it has one of its characters. SIL Open Font License.

const milaDisplayExt = localFont({
  src: "../../fonts/bodoni-moda-ext.woff2",
  weight: "400 900",
  declarations: [
    { prop: "font-family", value: "'Bodoni Moda'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-mila-display-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const milaDisplay = localFont({
  src: "../../fonts/bodoni-moda.woff2",
  weight: "400 900",
  declarations: [
    { prop: "font-family", value: "'Bodoni Moda'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-mila-display",
  display: "swap",
  preload: false,
  fallback: ["serif"],
  adjustFontFallback: "Times New Roman",
});

const milaBodyExt = localFont({
  src: "../../fonts/inter-tight-ext.woff2",
  weight: "100 900",
  declarations: [
    { prop: "font-family", value: "'Inter Tight'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-mila-body-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const milaBody = localFont({
  src: "../../fonts/inter-tight.woff2",
  weight: "100 900",
  declarations: [
    { prop: "font-family", value: "'Inter Tight'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-mila-body",
  display: "swap",
  preload: false,
  fallback: ["sans-serif"],
});

const milaMonoExt = localFont({
  src: [
    {
      path: "../../fonts/space-mono-400-ext.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../fonts/space-mono-700-ext.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  declarations: [
    { prop: "font-family", value: "'Space Mono'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-mila-mono-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const milaMono = localFont({
  src: [
    {
      path: "../../fonts/space-mono-400.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../fonts/space-mono-700.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  declarations: [
    { prop: "font-family", value: "'Space Mono'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-mila-mono",
  display: "swap",
  preload: false,
  fallback: ["monospace"],
});

const almaDisplayExt = localFont({
  src: "../../fonts/newsreader-ext.woff2",
  weight: "200 800",
  declarations: [
    { prop: "font-family", value: "'Newsreader'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-alma-display-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const almaDisplay = localFont({
  src: "../../fonts/newsreader.woff2",
  weight: "200 800",
  declarations: [
    { prop: "font-family", value: "'Newsreader'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-alma-display",
  display: "swap",
  preload: false,
  fallback: ["serif"],
  adjustFontFallback: "Times New Roman",
});

const almaBodyExt = localFont({
  src: "../../fonts/figtree-ext.woff2",
  weight: "300 900",
  declarations: [
    { prop: "font-family", value: "'Figtree'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-alma-body-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const almaBody = localFont({
  src: "../../fonts/figtree.woff2",
  weight: "300 900",
  declarations: [
    { prop: "font-family", value: "'Figtree'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-alma-body",
  display: "swap",
  preload: false,
  fallback: ["sans-serif"],
});

const nailDisplayExt = localFont({
  src: "../../fonts/big-shoulders-ext.woff2",
  weight: "100 900",
  declarations: [
    { prop: "font-family", value: "'Big Shoulders'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-nail-display-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const nailDisplay = localFont({
  src: "../../fonts/big-shoulders.woff2",
  weight: "100 900",
  declarations: [
    { prop: "font-family", value: "'Big Shoulders'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-nail-display",
  display: "swap",
  preload: false,
  fallback: ["sans-serif"],
});

const nailBodyExt = localFont({
  src: "../../fonts/manrope-ext.woff2",
  weight: "200 800",
  declarations: [
    { prop: "font-family", value: "'Manrope'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-nail-body-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const nailBody = localFont({
  src: "../../fonts/manrope.woff2",
  weight: "200 800",
  declarations: [
    { prop: "font-family", value: "'Manrope'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-nail-body",
  display: "swap",
  preload: false,
  fallback: ["sans-serif"],
});

const nailMonoExt = localFont({
  src: [
    {
      path: "../../fonts/dm-mono-400-ext.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../fonts/dm-mono-500-ext.woff2",
      weight: "500",
      style: "normal",
    },
  ],
  declarations: [
    { prop: "font-family", value: "'DM Mono'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-nail-mono-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const nailMono = localFont({
  src: [
    { path: "../../fonts/dm-mono-400.woff2", weight: "400", style: "normal" },
    { path: "../../fonts/dm-mono-500.woff2", weight: "500", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "'DM Mono'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-nail-mono",
  display: "swap",
  preload: false,
  fallback: ["monospace"],
});

const siteSansExt = localFont({
  src: "../../fonts/geist-ext.woff2",
  weight: "100 900",
  declarations: [
    { prop: "font-family", value: "'Geist'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-site-sans-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const siteSans = localFont({
  src: "../../fonts/geist.woff2",
  weight: "100 900",
  declarations: [
    { prop: "font-family", value: "'Geist'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-site-sans",
  display: "swap",
  preload: false,
  fallback: ["sans-serif"],
});

/** The classes that declare every face, for a site's root. */
export const siteFontClasses = [
  milaDisplay,
  milaDisplayExt,
  milaBody,
  milaBodyExt,
  milaMono,
  milaMonoExt,
  almaDisplay,
  almaDisplayExt,
  almaBody,
  almaBodyExt,
  nailDisplay,
  nailDisplayExt,
  nailBody,
  nailBodyExt,
  nailMono,
  nailMonoExt,
  siteSans,
  siteSansExt,
]
  .map((font) => font.variable)
  .join(" ");

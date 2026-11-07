import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import { BookingHostProvider } from "@/components/shared/booking-host";
import { bookingHost } from "@/lib/brand";

import "./globals.css";

// Self-hosted faces (src/fonts, see its README): the build never depends on
// a font service. Each face is two files, as Google Fonts serves them: latin,
// and latin-ext downloaded only by a page that has one of its characters
// (same family name, each with its unicode-range). SIL Open Font License.

const hankenGroteskExt = localFont({
  src: "../fonts/hanken-grotesk-ext.woff2",
  weight: "100 900",
  declarations: [
    { prop: "font-family", value: "'Hanken Grotesk'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-body-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const hankenGrotesk = localFont({
  src: "../fonts/hanken-grotesk.woff2",
  weight: "100 900",
  declarations: [
    { prop: "font-family", value: "'Hanken Grotesk'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-body",
  display: "swap",
  fallback: ["sans-serif"],
});

const instrumentSerifExt = localFont({
  src: [
    {
      path: "../fonts/instrument-serif-ext.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../fonts/instrument-serif-italic-ext.woff2",
      weight: "400",
      style: "italic",
    },
  ],
  declarations: [
    { prop: "font-family", value: "'Instrument Serif'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-serif-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const instrumentSerif = localFont({
  src: [
    { path: "../fonts/instrument-serif.woff2", weight: "400", style: "normal" },
    {
      path: "../fonts/instrument-serif-italic.woff2",
      weight: "400",
      style: "italic",
    },
  ],
  declarations: [
    { prop: "font-family", value: "'Instrument Serif'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-serif",
  display: "swap",
  fallback: ["serif"],
  adjustFontFallback: "Times New Roman",
});

// The professional area's Studio style, with its width axis. Not
// preloaded: only downloaded on the pages that use it.
const archivoExt = localFont({
  src: "../fonts/archivo-ext.woff2",
  weight: "100 900",
  declarations: [
    { prop: "font-family", value: "'Archivo'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
    { prop: "font-stretch", value: "62% 125%" },
  ],
  variable: "--font-studio-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const archivo = localFont({
  src: "../fonts/archivo.woff2",
  weight: "100 900",
  declarations: [
    { prop: "font-family", value: "'Archivo'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
    { prop: "font-stretch", value: "62% 125%" },
  ],
  variable: "--font-studio",
  display: "swap",
  preload: false,
  fallback: ["sans-serif"],
});

// The professional area's Écrin style: engraved lettering and a light sans.
// Not preloaded either.
const marcellusExt = localFont({
  src: "../fonts/marcellus-ext.woff2",
  weight: "400",
  declarations: [
    { prop: "font-family", value: "'Marcellus'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-engraved-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const marcellus = localFont({
  src: "../fonts/marcellus.woff2",
  weight: "400",
  declarations: [
    { prop: "font-family", value: "'Marcellus'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-engraved",
  display: "swap",
  preload: false,
  fallback: ["serif"],
  adjustFontFallback: "Times New Roman",
});

const jostExt = localFont({
  src: "../fonts/jost-ext.woff2",
  weight: "100 900",
  declarations: [
    { prop: "font-family", value: "'Jost'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-ecrin-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const jost = localFont({
  src: "../fonts/jost.woff2",
  weight: "100 900",
  declarations: [
    { prop: "font-family", value: "'Jost'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-ecrin",
  display: "swap",
  preload: false,
  fallback: ["sans-serif"],
});

// The professional area's Carnet style: a book face (with its optical
// sizes), and figures as a printer sets folios. Not preloaded either.
const newsreaderExt = localFont({
  src: [
    {
      path: "../fonts/newsreader-ext.woff2",
      weight: "200 800",
      style: "normal",
    },
    {
      path: "../fonts/newsreader-italic-ext.woff2",
      weight: "200 800",
      style: "italic",
    },
  ],
  declarations: [
    { prop: "font-family", value: "'Newsreader'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-carnet-serif-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const newsreader = localFont({
  src: [
    { path: "../fonts/newsreader.woff2", weight: "200 800", style: "normal" },
    {
      path: "../fonts/newsreader-italic.woff2",
      weight: "200 800",
      style: "italic",
    },
  ],
  declarations: [
    { prop: "font-family", value: "'Newsreader'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-carnet-serif",
  display: "swap",
  preload: false,
  fallback: ["serif"],
  adjustFontFallback: "Times New Roman",
});

const ibmPlexMonoExt = localFont({
  src: [
    {
      path: "../fonts/ibm-plex-mono-400-ext.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../fonts/ibm-plex-mono-500-ext.woff2",
      weight: "500",
      style: "normal",
    },
  ],
  declarations: [
    { prop: "font-family", value: "'IBM Plex Mono'" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  variable: "--font-carnet-mono-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
const ibmPlexMono = localFont({
  src: [
    {
      path: "../fonts/ibm-plex-mono-400.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../fonts/ibm-plex-mono-500.woff2",
      weight: "500",
      style: "normal",
    },
  ],
  declarations: [
    { prop: "font-family", value: "'IBM Plex Mono'" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  variable: "--font-carnet-mono",
  display: "swap",
  preload: false,
  fallback: ["monospace"],
});

export const metadata: Metadata = {
  title: {
    default: "Booking SaaS",
    template: "%s · Booking SaaS",
  },
  description:
    "Réservation, gestion clientes et fidélisation pour les indépendantes beauté.",
};

export const viewport: Viewport = {
  themeColor: "#f6f1ea",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="fr"
      className={`${hankenGrotesk.variable} ${hankenGroteskExt.variable} ${instrumentSerif.variable} ${instrumentSerifExt.variable} ${archivo.variable} ${archivoExt.variable} ${marcellus.variable} ${marcellusExt.variable} ${jost.variable} ${jostExt.variable} ${newsreader.variable} ${newsreaderExt.variable} ${ibmPlexMono.variable} ${ibmPlexMonoExt.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <BookingHostProvider host={bookingHost()}>
          {children}
        </BookingHostProvider>
      </body>
    </html>
  );
}

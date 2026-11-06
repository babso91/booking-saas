import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import { BookingHostProvider } from "@/components/shared/booking-host";
import { bookingHost } from "@/lib/brand";

import "./globals.css";

// Self-hosted faces (src/fonts, see its README): the build never depends on
// a font service. Latin and latin-ext, under the SIL Open Font License.

const hankenGrotesk = localFont({
  src: "../fonts/hanken-grotesk.woff2",
  weight: "100 900",
  // Its own name, as the pages and tests read it.
  declarations: [{ prop: "font-family", value: "'Hanken Grotesk'" }],
  variable: "--font-body",
  display: "swap",
  fallback: ["sans-serif"],
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
  // Its own name, as the pages and tests read it.
  declarations: [{ prop: "font-family", value: "'Instrument Serif'" }],
  variable: "--font-serif",
  display: "swap",
  fallback: ["serif"],
  adjustFontFallback: "Times New Roman",
});

// The professional area's Studio style. Not preloaded: only downloaded on
// the pages that use it.
const archivo = localFont({
  src: "../fonts/archivo.woff2",
  weight: "100 900",
  // Its own name, and its width axis as the pages use it.
  declarations: [
    { prop: "font-family", value: "'Archivo'" },
    { prop: "font-stretch", value: "62% 125%" },
  ],
  variable: "--font-studio",
  display: "swap",
  preload: false,
  fallback: ["sans-serif"],
});

// The professional area's Écrin style: engraved lettering and a light sans.
// Not preloaded either.
const marcellus = localFont({
  src: "../fonts/marcellus.woff2",
  weight: "400",
  // Its own name, as the pages and tests read it.
  declarations: [{ prop: "font-family", value: "'Marcellus'" }],
  variable: "--font-engraved",
  display: "swap",
  preload: false,
  fallback: ["serif"],
  adjustFontFallback: "Times New Roman",
});
const jost = localFont({
  src: "../fonts/jost.woff2",
  weight: "100 900",
  // Its own name, as the pages and tests read it.
  declarations: [{ prop: "font-family", value: "'Jost'" }],
  variable: "--font-ecrin",
  display: "swap",
  preload: false,
  fallback: ["sans-serif"],
});

// The professional area's Carnet style: a book face (with its optical
// sizes), and figures as a printer sets folios. Not preloaded either.
const newsreader = localFont({
  src: [
    { path: "../fonts/newsreader.woff2", weight: "200 800", style: "normal" },
    {
      path: "../fonts/newsreader-italic.woff2",
      weight: "200 800",
      style: "italic",
    },
  ],
  // Its own name, as the pages and tests read it.
  declarations: [{ prop: "font-family", value: "'Newsreader'" }],
  variable: "--font-carnet-serif",
  display: "swap",
  preload: false,
  fallback: ["serif"],
  adjustFontFallback: "Times New Roman",
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
  // Its own name, as the pages and tests read it.
  declarations: [{ prop: "font-family", value: "'IBM Plex Mono'" }],
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
      className={`${hankenGrotesk.variable} ${instrumentSerif.variable} ${archivo.variable} ${marcellus.variable} ${jost.variable} ${newsreader.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <BookingHostProvider host={bookingHost()}>
          {children}
        </BookingHostProvider>
      </body>
    </html>
  );
}

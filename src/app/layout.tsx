import type { Metadata, Viewport } from "next";
import {
  Archivo,
  Hanken_Grotesk,
  IBM_Plex_Mono,
  Instrument_Serif,
  Jost,
  Marcellus,
  Newsreader,
} from "next/font/google";

import { BookingHostProvider } from "@/components/shared/booking-host";
import { bookingHost } from "@/lib/brand";

import "./globals.css";

const body = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});

// The professional area's Studio style. Not preloaded: only downloaded on
// the pages that use it.
const studio = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-studio",
  display: "swap",
  preload: false,
});

// The professional area's Écrin style: engraved lettering and a light sans.
// Not preloaded either.
const engraved = Marcellus({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-engraved",
  display: "swap",
  preload: false,
});
const ecrinSans = Jost({
  subsets: ["latin"],
  variable: "--font-ecrin",
  display: "swap",
  preload: false,
});

// The professional area's Carnet style: a book face, and figures as a printer
// sets folios. Not preloaded either.
const carnetSerif = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  variable: "--font-carnet-serif",
  display: "swap",
  preload: false,
});
const carnetMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-carnet-mono",
  display: "swap",
  preload: false,
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
      className={`${body.variable} ${serif.variable} ${studio.variable} ${engraved.variable} ${ecrinSans.variable} ${carnetSerif.variable} ${carnetMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <BookingHostProvider host={bookingHost()}>
          {children}
        </BookingHostProvider>
      </body>
    </html>
  );
}

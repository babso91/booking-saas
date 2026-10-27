import type { Metadata, Viewport } from "next";
import { Archivo, Hanken_Grotesk, Instrument_Serif } from "next/font/google";

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
      className={`${body.variable} ${serif.variable} ${studio.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}

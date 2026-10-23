import type { Metadata } from "next";
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
import { notFound } from "next/navigation";

// Experience lab: prototypes of a professional's public mini-site on
// fictional data (branch proto/experience-engine only).

const milaDisplay = Bodoni_Moda({
  subsets: ["latin"],
  variable: "--font-mila-display",
  display: "swap",
});
const milaBody = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-mila-body",
  display: "swap",
});
const milaMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-mila-mono",
  display: "swap",
});
const almaDisplay = Newsreader({
  subsets: ["latin"],
  weight: ["300", "400"],
  variable: "--font-alma-display",
  display: "swap",
});
const almaBody = Figtree({
  subsets: ["latin"],
  variable: "--font-alma-body",
  display: "swap",
});
const nailDisplay = Big_Shoulders({
  subsets: ["latin"],
  weight: ["700", "800", "900"],
  variable: "--font-nail-display",
  display: "swap",
});
const nailBody = Manrope({
  subsets: ["latin"],
  variable: "--font-nail-body",
  display: "swap",
});
const nailMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-nail-mono",
  display: "swap",
});
const labSans = Geist({
  subsets: ["latin"],
  variable: "--font-lab-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Labo",
  robots: { index: false, follow: false },
};

export default function LabLayout({ children }: LayoutProps<"/labo">) {
  // Production builds 404 the lab, except an isolated, explicitly enabled
  // lab instance (LAB_PUBLIC=1) used for remote tests behind a gatekeeper.
  if (process.env.NODE_ENV === "production" && process.env.LAB_PUBLIC !== "1")
    notFound();
  return (
    <div
      className={[
        milaDisplay,
        milaBody,
        milaMono,
        almaDisplay,
        almaBody,
        nailDisplay,
        nailBody,
        nailMono,
        labSans,
      ]
        .map((font) => font.variable)
        .join(" ")}
    >
      {children}
    </div>
  );
}

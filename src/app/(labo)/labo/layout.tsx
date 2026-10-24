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
//
// Every universe's faces are declared here (the studio switches universe
// and Signature mixes type pairs live), but none is preloaded: a page then
// downloads only the faces it actually shows (2 or 3, not all 14 files),
// instead of making the opening photo wait behind them on a phone.

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
const labSans = Geist({
  subsets: ["latin"],
  variable: "--font-lab-sans",
  display: "swap",
  preload: false,
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
  // data-lab-fonts: modals rendered on <body> read the faces from here.
  return (
    <div
      data-lab-fonts=""
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

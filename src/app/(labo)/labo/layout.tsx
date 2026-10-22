import type { Metadata } from "next";
import {
  Bodoni_Moda,
  Figtree,
  Geist,
  Inter_Tight,
  Newsreader,
  Space_Mono,
} from "next/font/google";
import { notFound } from "next/navigation";

// Experience lab: prototypes of a professional's public mini-site on
// fictional data. Never served by a production build (branch
// proto/experience-engine only).

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
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div
      className={[
        milaDisplay,
        milaBody,
        milaMono,
        almaDisplay,
        almaBody,
        labSans,
      ]
        .map((font) => font.variable)
        .join(" ")}
    >
      {children}
    </div>
  );
}

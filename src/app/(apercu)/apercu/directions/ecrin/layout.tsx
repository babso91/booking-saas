import { Jost, Marcellus } from "next/font/google";

import { DirectionRoot } from "@/features/directions/direction-root";
import styles from "@/features/directions/ecrin/ecrin.module.css";

const engraved = Marcellus({
  subsets: ["latin"],
  weight: "400",
  variable: "--ecrin-engraved",
});

const sans = Jost({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  variable: "--ecrin-sans",
});

const palettes = [
  { id: "nacre", name: "Nacre", swatch: "#8C74B0" },
  { id: "poudre", name: "Poudre", swatch: "#B46A6C" },
  { id: "jade", name: "Jade", swatch: "#4F8A7A" },
];

export default function EcrinLayout({
  children,
}: LayoutProps<"/apercu/directions/ecrin">) {
  return (
    <DirectionRoot
      direction="ecrin"
      palettes={palettes}
      className={`${engraved.variable} ${sans.variable} ${styles.root}`}
    >
      {children}
    </DirectionRoot>
  );
}

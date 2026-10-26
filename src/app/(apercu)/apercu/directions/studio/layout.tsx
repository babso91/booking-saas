import { Archivo } from "next/font/google";

import { DirectionRoot } from "@/features/directions/direction-root";
import styles from "@/features/directions/studio/studio.module.css";

const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--studio-font",
});

const palettes = [
  { id: "cobalt", name: "Cobalt", swatch: "#2D3FE6" },
  { id: "tomate", name: "Tomate", swatch: "#F2512E" },
  { id: "pistache", name: "Pistache", swatch: "#C3DD4F" },
];

export default function StudioLayout({
  children,
}: LayoutProps<"/apercu/directions/studio">) {
  return (
    <DirectionRoot
      direction="studio"
      palettes={palettes}
      className={`${archivo.variable} ${styles.root}`}
    >
      {children}
    </DirectionRoot>
  );
}

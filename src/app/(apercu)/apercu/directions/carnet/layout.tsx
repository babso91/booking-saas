import { IBM_Plex_Mono, Newsreader } from "next/font/google";

import { DirectionRoot } from "@/features/directions/direction-root";
import styles from "@/features/directions/carnet/carnet.module.css";

const serif = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  variable: "--carnet-serif",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--carnet-mono",
});

const palettes = [
  { id: "ivoire", name: "Ivoire", swatch: "#B4412E" },
  { id: "encre", name: "Encre bleue", swatch: "#2C44A8" },
  { id: "olive", name: "Olive", swatch: "#5E6B2E" },
];

export default function CarnetLayout({
  children,
}: LayoutProps<"/apercu/directions/carnet">) {
  return (
    <DirectionRoot
      direction="carnet"
      palettes={palettes}
      className={`${serif.variable} ${mono.variable} ${styles.root}`}
    >
      {children}
    </DirectionRoot>
  );
}

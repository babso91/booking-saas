import type { Metadata, Viewport } from "next";
import Link from "next/link";

import { EclipseScene } from "@/features/brand/eclipse-scene";
import styles from "@/features/brand/home.module.css";

export const metadata: Metadata = {
  title: { absolute: "Higani" },
  description:
    "Un site à ton image, une réservation sans compte pour tes clientes, un agenda calme pour tes journées.",
};

export const viewport: Viewport = {
  themeColor: "#050507",
};

// Higani's home, in its own universe « Éclipse » (brand direction V2.2),
// until the full landing page. During the private beta its one action is
// to sign in; joining is by invitation, said plainly.
export default function HomePage() {
  return (
    <main className="relative isolate flex min-h-svh flex-col overflow-hidden bg-[#050507] text-[#E9EDF5]">
      <EclipseScene />
      <div aria-hidden="true" className={styles.scrim} />
      <header className="relative z-10 px-6 pt-[max(env(safe-area-inset-top),24px)] sm:px-12">
        <p
          className={`${styles.wide} text-[13px] font-semibold tracking-[0.22em]`}
        >
          HIGANI
        </p>
      </header>
      <div
        className={`${styles.words} relative z-10 mt-auto flex max-w-[56rem] flex-col gap-6 px-6 pb-[max(env(safe-area-inset-bottom),40px)] sm:my-auto sm:px-12 sm:pb-0`}
      >
        <h1
          className={`${styles.wide} text-[clamp(30px,9.4vw,52px)] sm:text-[clamp(44px,4.8vw,68px)] leading-[0.94] font-medium tracking-[-0.04em] text-balance`}
        >
          <span className="block">Ton lien.</span>{" "}
          <span className="block">Ton univers.</span>{" "}
          <span className="block">
            Tes <span className="whitespace-nowrap">rendez-vous.</span>
          </span>
        </h1>
        <p className="max-w-[34rem] text-[17px] leading-relaxed text-[#B9C0CF] sm:text-[18px]">
          Un site à ton image, une réservation sans compte pour tes clientes, un
          agenda calme pour tes journées.
        </p>
        <div className="flex flex-col items-start gap-4">
          <Link
            href="/login"
            className="inline-flex min-h-12 items-center rounded-full bg-[#FF3159] px-7 text-[16px] font-bold text-[#0B0D14] transition-colors hover:bg-[#ff5274] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#E9EDF5]"
          >
            Se connecter
          </Link>
          <Link
            href="/signup"
            className="inline-flex min-h-11 items-center text-[14px] text-[#B9C0CF] underline decoration-[#5C6378] underline-offset-4 hover:text-[#E9EDF5] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#E9EDF5]"
          >
            Bêta privée, sur invitation
          </Link>
        </div>
      </div>
    </main>
  );
}

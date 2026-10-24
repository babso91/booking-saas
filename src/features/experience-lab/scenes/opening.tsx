"use client";

import { motion, useScroll, useTransform } from "motion/react";
import { useRef } from "react";

import {
  Detail,
  Display,
  EditTarget,
  GradedPhoto,
  useEngine,
} from "../engine/engine";
import type { OpeningVariant } from "../engine/config";

// Opening scenes: the first frame of a professional's site. Each is its
// own composition; the cover's entrance follows the motion language.

export function Opening({ variant }: { variant: OpeningVariant }) {
  if (variant === "bloom") return <BloomOpening />;
  if (variant === "kinetic") return <KineticOpening />;
  return <DidoneCutOpening />;
}

/** The cover's first appearance, in the site's motion language. */
function useCoverEntrance() {
  const { motion: language } = useEngine();
  const { ease, entrance } = language;
  if (entrance === "cut") {
    return {
      frame: {
        initial: { clipPath: "inset(0 0 100% 0)" },
        animate: { clipPath: "inset(0 0 0% 0)" },
        transition: { duration: 1, ease },
      },
      image: {
        initial: { scale: 1.25 },
        animate: { scale: 1 },
        transition: { duration: 1.4, ease },
      },
    };
  }
  if (entrance === "snap") {
    return {
      frame: {
        initial: { opacity: 0, scale: 0.9 },
        animate: { opacity: 1, scale: 1 },
        transition: { duration: 0.7, ease },
      },
      image: {
        initial: { scale: 1.1 },
        animate: { scale: 1 },
        transition: { duration: 0.9, ease },
      },
    };
  }
  return {
    frame: {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      transition: { duration: 2.2, ease },
    },
    image: {
      initial: { scale: 1.12 },
      animate: { scale: 1 },
      transition: { duration: 6, ease },
    },
  };
}

/** Lookbook cover: the photo cut in, an enormous name over it. */
function DidoneCutOpening() {
  const { config, motion: language } = useEngine();
  const entrance = useCoverEntrance();
  const section = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: section,
    offset: ["start start", "end start"],
  });
  const scale = useTransform(scrollYProgress, [0, 1], [1, 0.82]);
  const titleY = useTransform(scrollYProgress, [0, 1], ["0%", "-60%"]);
  const wait = language.entrance === "bloom" ? 1.2 : 0.7;
  const name = config.brand.name.split(" ").at(-1) ?? config.brand.name;

  return (
    <section ref={section} className="relative h-[115svh] bg-[var(--u-bg)]">
      <motion.div
        className="sticky top-0 h-svh overflow-hidden"
        style={{ scale }}
      >
        <motion.div
          className="absolute inset-0 overflow-hidden"
          {...entrance.frame}
        >
          <motion.div className="absolute inset-0" {...entrance.image}>
            <GradedPhoto id={config.content.cover} alt="" eager />
          </motion.div>
          <EditTarget slot="cover" />
        </motion.div>
        <div className="grain pointer-events-none absolute inset-0" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] bg-[linear-gradient(0deg,rgba(0,0,0,.85),transparent)]" />
        <motion.div
          style={{ y: titleY }}
          className="absolute inset-x-0 bottom-0 px-4 pb-[calc(max(env(safe-area-inset-bottom),14px)+76px)] text-white mix-blend-difference"
        >
          <motion.p
            initial={{ clipPath: "inset(0 100% 0 0)" }}
            animate={{ clipPath: "inset(0 0% 0 0)" }}
            transition={{ duration: 0.9, delay: wait, ease: language.ease }}
            className="flex justify-between"
          >
            <Detail>Nº 01 — {config.brand.kind}</Detail>
            <Detail>{config.brand.location}</Detail>
          </motion.p>
          <h1 className="overflow-hidden">
            <motion.span
              initial={{ y: "105%" }}
              animate={{ y: "0%" }}
              transition={{
                duration: 0.9,
                delay: wait + 0.1,
                ease: language.ease,
              }}
              className="block"
            >
              <Display className="block text-[34vw] leading-[0.8] md:text-[24vw]">
                {name}
              </Display>
            </motion.span>
          </h1>
        </motion.div>
      </motion.div>
    </section>
  );
}

/** Sensory cover: light blooms, the name surfaces word by word. */
function BloomOpening() {
  const { config, motion: language } = useEngine();
  const entrance = useCoverEntrance();
  const section = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: section,
    offset: ["start start", "end start"],
  });
  const veil = useTransform(scrollYProgress, [0, 0.8], [0.15, 0.75]);
  const titleY = useTransform(scrollYProgress, [0, 1], [0, 120]);
  // The photo blooms first, then her name surfaces: soon enough that her
  // name is read within the first seconds, even on a slow phone.
  const wait = language.entrance === "bloom" ? 0.6 : 0.45;
  const words = config.brand.name.split(" ");

  return (
    <section
      ref={section}
      className="relative h-[120svh] bg-[var(--u-bg)] text-[var(--u-ink)]"
    >
      <div className="sticky top-0 h-svh overflow-hidden">
        <motion.div
          className="absolute inset-0 overflow-hidden"
          {...entrance.frame}
        >
          <motion.div className="absolute inset-0" {...entrance.image}>
            <GradedPhoto id={config.content.cover} alt="" eager />
          </motion.div>
          <EditTarget slot="cover" />
        </motion.div>
        <motion.div
          className="absolute inset-0 bg-[var(--u-bg)]"
          style={{ opacity: veil }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 70% at 50% 110%, color-mix(in srgb, var(--u-bg) 95%, transparent) 20%, transparent 70%)",
          }}
        />
        <motion.div
          style={{ y: titleY }}
          className="absolute inset-x-0 bottom-[14svh] px-6 text-center"
        >
          <h1 className="text-[clamp(52px,16vw,120px)] leading-[0.95]">
            {words.map((word, index) => (
              <motion.span
                key={`${word}-${index}`}
                className="inline-block"
                initial={{ opacity: 0, y: 24, filter: "blur(8px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{
                  duration: language.duration * 1.1,
                  delay: wait + index * 0.25,
                  ease: language.ease,
                }}
              >
                <Display>{word}</Display>
                {index < words.length - 1 ? " " : ""}
              </motion.span>
            ))}
          </h1>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.8 }}
            transition={{ duration: 1.4, delay: wait + 0.8 }}
            className="mt-4"
          >
            <Detail>
              {config.brand.kind} · {config.brand.location}
            </Detail>
          </motion.p>
          <motion.span
            aria-hidden="true"
            className="mx-auto mt-10 block h-12 w-px origin-top bg-[var(--u-ink)]/50"
            initial={{ scaleY: 0 }}
            animate={{ scaleY: [0, 1, 0] }}
            transition={{
              duration: 3,
              delay: wait + 1.4,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        </motion.div>
      </div>
    </section>
  );
}

/**
 * Expressive cover: the name runs in bands across the accent field, the
 * photo is a tilted card, and a spinning seal books in one tap.
 */
function KineticOpening() {
  const { config, motion: language, book } = useEngine();
  const entrance = useCoverEntrance();
  const name = config.brand.name;
  const band = `${name} ✶ ${config.brand.kind} ✶ `.repeat(4);

  return (
    <section className="relative flex min-h-svh flex-col justify-center overflow-hidden bg-[var(--u-accent)] pt-20 pb-28 text-[var(--u-on-accent)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex flex-col justify-center gap-2 opacity-95"
      >
        {[0, 1, 2].map((row) => (
          <motion.div
            key={row}
            className="whitespace-nowrap"
            initial={{ x: row % 2 ? "-50%" : "0%" }}
            animate={{ x: row % 2 ? "0%" : "-50%" }}
            transition={{
              duration: 26 + row * 6,
              repeat: Infinity,
              ease: "linear",
            }}
          >
            <Display className="text-[22vw] leading-[0.86] md:text-[14vw]">
              {band}
            </Display>
          </motion.div>
        ))}
      </div>
      <motion.div
        className="relative mx-auto aspect-[3/4] w-[64vw] max-w-[360px] overflow-hidden shadow-[0_40px_80px_-30px_rgba(0,0,0,.6)]"
        style={{ borderRadius: "var(--s-radius)", rotate: -4 }}
        {...entrance.frame}
        whileHover={{ rotate: 0, scale: 1.02 }}
      >
        <motion.div className="absolute inset-0" {...entrance.image}>
          <GradedPhoto id={config.content.cover} alt="" eager sizes="64vw" />
        </motion.div>
        <EditTarget slot="cover" />
      </motion.div>
      <motion.p
        className="relative mt-8 px-6 text-center"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: language.duration,
          delay: 0.5,
          ease: language.ease,
        }}
      >
        <Detail>
          {config.brand.location} — réservation en ligne, sans compte
        </Detail>
      </motion.p>
      <motion.button
        type="button"
        onClick={() => book(null)}
        aria-label={`Réserver chez ${name}`}
        className="absolute right-[6vw] bottom-[18svh] size-28 cursor-pointer rounded-full bg-[var(--u-bg)] text-[var(--u-ink)] md:size-36"
        initial={{ scale: 0, rotate: -90 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ duration: 0.7, delay: 0.8, ease: language.ease }}
        whileTap={{ scale: 0.92 }}
      >
        <motion.svg
          viewBox="0 0 100 100"
          className="absolute inset-0"
          animate={{ rotate: 360 }}
          transition={{ duration: 14, repeat: Infinity, ease: "linear" }}
          aria-hidden="true"
        >
          <defs>
            <path
              id="seal"
              d="M50 50 m-36 0 a36 36 0 1 1 72 0 a36 36 0 1 1 -72 0"
            />
          </defs>
          <text
            fontSize="10.5"

            fill="currentColor"
            style={{ fontFamily: "var(--t-detail)" }}
          >
            <textPath href="#seal" textLength="224" lengthAdjust="spacing">
              RÉSERVER ✶ RÉSERVER ✶
            </textPath>
          </text>
        </motion.svg>
        <span className="relative text-[26px]" aria-hidden="true">
          →
        </span>
      </motion.button>
    </section>
  );
}

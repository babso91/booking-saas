"use client";

import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react";
import { useRef } from "react";

import type { PortraitVariant } from "../engine/config";
import {
  Detail,
  Display,
  EditTarget,
  GradedPhoto,
  Note,
  useEngine,
  useReveal,
} from "../engine/engine";

// The person behind the work. Customers book a hand they trust: her name,
// her craft in her own words, a photo of her at work. Two compositions:
// an editorial page whose name overlaps the photo (Mila, Nail Lab), and an
// arch that breathes with the scroll (Alma). Her photo is hers like the
// others: replaced and framed from the studio, or touched in the preview.

export function Portrait({
  variant,
  index,
}: {
  variant: PortraitVariant;
  index: number;
}) {
  return variant === "arch" ? <Arch /> : <Editorial index={index} />;
}

function Editorial({ index }: { index: number }) {
  const { config } = useEngine();
  const reveal = useReveal();
  const portrait = config.content.portrait;
  return (
    <section className="bg-[var(--u-bg)] text-[var(--u-ink)]">
      <div className="mx-auto max-w-[1100px] px-5 pt-6 pb-28 md:pb-36">
        <div className="flex items-baseline justify-between border-t border-[var(--u-line)] pt-4 text-[var(--u-muted)]">
          <Detail>({String(index).padStart(2, "0")}) Portrait</Detail>
        </div>
        <div className="mt-10 md:grid md:grid-cols-12 md:items-end md:gap-10">
          <motion.div
            className="relative aspect-[4/5] overflow-hidden md:col-span-6"
            style={{ borderRadius: "var(--s-radius)" }}
            {...reveal()}
          >
            <GradedPhoto
              id={portrait.photo}
              alt={`${portrait.name} au travail`}
              sizes="(min-width: 768px) 50vw, 92vw"
            />
            <EditTarget slot="portrait" />
          </motion.div>
          <div className="relative z-10 md:col-span-6">
            <motion.h2
              className="-mt-[0.42em] text-[clamp(64px,22vw,150px)] leading-[0.85] [overflow-wrap:anywhere] md:mt-0"
              {...reveal(1)}
            >
              <Display>{portrait.name}</Display>
            </motion.h2>
            <span className="mt-3 block text-[var(--u-muted)]">
              <Detail>{portrait.role}</Detail>
            </span>
            <motion.p
              className="mt-6 max-w-[34ch] text-[18px] leading-relaxed md:text-[20px]"
              {...reveal(2)}
            >
              {portrait.text}
            </motion.p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Arch() {
  const { config } = useEngine();
  const reveal = useReveal();
  const portrait = config.content.portrait;
  const frame = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: frame,
    offset: ["start end", "end start"],
  });
  const drift = useTransform(scrollYProgress, [0, 1], ["-8%", "8%"]);
  // No scroll-driven drift when she asked for less motion.
  const y = useReducedMotion() ? "0%" : drift;
  return (
    <section className="bg-[var(--u-bg)] text-[var(--u-ink)]">
      <div className="mx-auto flex max-w-[640px] flex-col items-center px-6 pt-8 pb-32 text-center">
        <motion.div
          ref={frame}
          className="relative aspect-[3/4] w-[74%] max-w-[360px] overflow-hidden"
          style={{
            borderRadius: "999px 999px var(--s-radius) var(--s-radius)",
          }}
          {...reveal()}
        >
          <motion.div className="absolute inset-[-10%]" style={{ y }}>
            <GradedPhoto
              id={portrait.photo}
              alt={`${portrait.name} au travail`}
              sizes="(min-width: 768px) 360px, 74vw"
            />
          </motion.div>
          <EditTarget slot="portrait" />
        </motion.div>
        <motion.h2
          className="mt-10 text-[44px] leading-none [overflow-wrap:anywhere] md:text-[56px]"
          {...reveal(1)}
        >
          <Display>{portrait.name}</Display>
        </motion.h2>
        <span className="mt-3 text-[var(--u-muted)]">
          <Note>{portrait.role}</Note>
        </span>
        <motion.p
          className="mt-8 max-w-[32ch] text-[19px] leading-relaxed md:text-[21px]"
          {...reveal(2)}
        >
          <Display>{portrait.text}</Display>
        </motion.p>
      </div>
    </section>
  );
}

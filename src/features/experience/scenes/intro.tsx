"use client";
import { sectionTitle } from "@/features/sites/presentation";

import { motion } from "motion/react";

import type { IntroVariant } from "../engine/config";
import { Detail, Display, useEngine, useReveal } from "../engine/engine";

// The professional's own words, staged two ways.

export function Intro({
  variant,
  index,
}: {
  variant: IntroVariant;
  index: number;
}) {
  const { config } = useEngine();
  const reveal = useReveal();
  const title = sectionTitle(
    config.presentation,
    "intro",
    variant === "statement" ? "Manifeste" : "",
  );
  const text = config.brand.intro;

  if (variant === "lines") {
    return (
      <section className="bg-[var(--u-bg)] text-[var(--u-ink)]">
        <div className="mx-auto max-w-[760px] px-6 py-28 text-center md:py-40">
          {title && (
            <h2 className="mb-6">
              <Detail>{title}</Detail>
            </h2>
          )}
          <p className="text-[30px] leading-[1.25] md:text-[44px]">
            {text.split(/(?<=[.,])\s/).map((line, position) => (
              <motion.span
                key={position}
                className="block"
                {...reveal(position)}
              >
                <Display>{line}</Display>
              </motion.span>
            ))}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="bg-[var(--u-bg)] text-[var(--u-ink)]">
      <div className="mx-auto max-w-[1100px] px-5 py-24 md:py-36">
        {title && (
          <Detail className="text-[var(--u-muted)]">
            ({String(index).padStart(2, "0")}) {title}
          </Detail>
        )}
        <motion.p
          className="mt-6 max-w-[18ch] text-[36px] leading-[1.05] md:text-[64px]"
          {...reveal()}
        >
          <Display>{text}</Display>
        </motion.p>
      </div>
    </section>
  );
}

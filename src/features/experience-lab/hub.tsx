"use client";

import { motion } from "motion/react";

import { Cover } from "./parts";
import { alma, mila, type Universe } from "./universes";

// The neutral hub: our product's own, quiet space. It lists the customer's
// businesses; each one is a door into that brand's universe.

const businesses: { universe: Universe; next: string; points: number }[] = [
  {
    universe: mila,
    next: "Dim. 25 oct. · 10:00 · Volume russe",
    points: mila.loyalty.balance,
  },
  {
    universe: alma,
    next: "Aucun rendez-vous prévu",
    points: alma.loyalty.balance,
  },
];

export function Hub({ onEnter }: { onEnter: (id: Universe["id"]) => void }) {
  return (
    <div
      className="min-h-dvh bg-[#F7F7F5] text-[#141414]"
      style={{ fontFamily: "var(--font-lab-sans)" }}
    >
      <div className="mx-auto max-w-[560px] px-5 pt-[max(env(safe-area-inset-top),20px)] pb-16">
        <header className="flex items-center justify-between py-3">
          <span className="text-[15px] font-semibold tracking-[-0.01em]">
            Mon espace
          </span>
          <span className="flex size-9 items-center justify-center rounded-full bg-[#141414] text-[14px] font-semibold text-white">
            C
          </span>
        </header>

        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="mt-8 text-[40px] leading-[1.02] font-semibold tracking-[-0.035em]"
        >
          Bonjour Camille
        </motion.h1>
        <p className="mt-3 text-[16px] leading-relaxed text-[#6B6B66]">
          Vos deux adresses. Entrez dans l’une d’elles pour vos rendez-vous et
          vos avantages.
        </p>

        <ul className="mt-9 flex flex-col gap-8">
          {businesses.map(({ universe, next, points }, index) => (
            <motion.li
              key={universe.id}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.6,
                delay: 0.08 + index * 0.08,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              <button
                type="button"
                onClick={() => onEnter(universe.id)}
                className="group block w-full cursor-pointer text-left"
                aria-label={`Entrer chez ${universe.name}`}
              >
                <Cover
                  universe={universe}
                  className="h-[230px] w-full"
                  style={{ borderRadius: 22 }}
                  imageStyle={{
                    filter:
                      universe.id === "mila"
                        ? "grayscale(1) contrast(1.1)"
                        : "saturate(.85)",
                  }}
                />
                <div className="mt-4 flex items-start justify-between gap-4 px-1">
                  <div className="min-w-0">
                    <p className="text-[20px] font-semibold tracking-[-0.02em]">
                      {universe.name}
                    </p>
                    <p className="mt-0.5 text-[14.5px] text-[#6B6B66]">
                      {universe.kind} · {universe.location}
                    </p>
                    <p className="mt-3 text-[14.5px] text-[#141414]">{next}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-[22px] font-semibold tabular-nums tracking-[-0.02em]">
                      {points}
                    </p>
                    <p className="text-[12.5px] text-[#6B6B66]">points</p>
                  </div>
                </div>
                <span className="mt-4 flex items-center gap-2 px-1 text-[14.5px] font-medium">
                  Entrer
                  <span
                    className="transition-transform duration-300 group-hover:translate-x-1"
                    aria-hidden="true"
                  >
                    →
                  </span>
                </span>
              </button>
            </motion.li>
          ))}
        </ul>
      </div>
    </div>
  );
}

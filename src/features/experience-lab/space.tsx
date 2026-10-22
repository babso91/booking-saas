"use client";

import { motion } from "motion/react";
import { useEffect } from "react";

import type { Booked } from "./booking";
import { minutes } from "./parts";
import type { Universe } from "./universes";

// The customer's space inside a brand: the same content everywhere (next
// visit, balance, rewards — the Client Hub contract), staged by the
// universe. Read only: rewards are asked for on site.

export function ClientSpace({
  universe,
  booked,
  onClose,
}: {
  universe: Universe;
  booked: Booked | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  return universe.id === "mila" ? (
    <MilaSpace universe={universe} booked={booked} onClose={onClose} />
  ) : (
    <AlmaSpace universe={universe} booked={booked} onClose={onClose} />
  );
}

type Props = { universe: Universe; booked: Booked | null; onClose: () => void };

const mono = { fontFamily: "var(--font-mila-mono)" } as const;
const didone = { fontFamily: "var(--font-mila-display)" } as const;

function MilaSpace({ universe, booked, onClose }: Props) {
  const { loyalty } = universe;
  const next = loyalty.rewards.find((reward) => !reward.eligible);
  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Ma carte"
      className="fixed inset-0 z-50 overflow-y-auto bg-[var(--u-bg)] text-[var(--u-ink)]"
      initial={{ clipPath: "inset(0 0 0 100%)" }}
      animate={{ clipPath: "inset(0 0 0 0%)" }}
      exit={{ clipPath: "inset(0 100% 0 0)" }}
      transition={{ duration: 0.6, ease: [0.76, 0, 0.24, 1] }}
    >
      <div className="mx-auto max-w-[720px] px-5 pt-[max(env(safe-area-inset-top),16px)] pb-16">
        <div
          className="flex justify-between text-[11.5px] tracking-[0.1em] uppercase"
          style={mono}
        >
          <span>Ma carte — Studio Mila</span>
          <button type="button" onClick={onClose} className="cursor-pointer">
            Fermer ✕
          </button>
        </div>

        <p
          className="mt-16 text-[11.5px] tracking-[0.1em] text-[var(--u-muted)] uppercase"
          style={mono}
        >
          Solde
        </p>
        <p
          className="text-[42vw] leading-[0.8] tracking-[-0.05em] md:text-[220px]"
          style={didone}
        >
          {loyalty.balance}
        </p>
        <div className="mt-6 flex gap-[3px]" aria-hidden="true">
          {Array.from({ length: 40 }, (_, index) => (
            <span
              key={index}
              className={`h-6 flex-1 ${index < Math.round((loyalty.balance / 400) * 40) ? "bg-[var(--u-ink)]" : "bg-[var(--u-line)]"} ${index % 10 === 0 ? "h-9" : ""}`}
            />
          ))}
        </div>
        {next ? (
          <p className="mt-4 text-[15px]">
            Encore{" "}
            <span className="text-[var(--u-accent)]">
              {next.missingPoints} points
            </span>{" "}
            avant {next.name}.
          </p>
        ) : null}

        <div
          className="mt-14 border-t border-[var(--u-line)] pt-4 text-[11.5px] tracking-[0.1em] text-[var(--u-muted)] uppercase"
          style={mono}
        >
          Prochain rendez-vous
        </div>
        <p className="mt-4 text-[30px] leading-tight" style={didone}>
          {booked ? `${booked.service.name}` : "Volume russe"}
        </p>
        <p className="mt-1 text-[14px] text-[var(--u-muted)]" style={mono}>
          {booked
            ? `${booked.day} · ${booked.time} · ${minutes(booked.service.durationMinutes)}`
            : "Dim 25 oct · 10:00 · 2 h 30"}
        </p>

        <div
          className="mt-14 border-t border-[var(--u-line)] pt-4 text-[11.5px] tracking-[0.1em] text-[var(--u-muted)] uppercase"
          style={mono}
        >
          Récompenses
        </div>
        <ol>
          {loyalty.rewards.map((reward, index) => (
            <li
              key={reward.id}
              className="grid grid-cols-[2.2rem_1fr_auto] items-baseline gap-x-2 border-b border-[var(--u-line)] py-5"
            >
              <span className="text-[11.5px]" style={mono}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="text-[26px] leading-tight" style={didone}>
                {reward.name}
              </span>
              <span
                className={`text-[12px] tracking-[0.08em] uppercase ${reward.eligible ? "text-[var(--u-accent)]" : "text-[var(--u-muted)]"}`}
                style={mono}
              >
                {reward.eligible
                  ? "Disponible"
                  : `${reward.pointsRequired} pts`}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-[13px] leading-relaxed text-[var(--u-muted)]">
          Une récompense disponible se demande au studio : elle ne s’applique
          pas d’elle-même.
        </p>
      </div>
    </motion.div>
  );
}

const serif = { fontFamily: "var(--font-alma-display)" } as const;

function AlmaSpace({ universe, booked, onClose }: Props) {
  const { loyalty } = universe;
  const next = loyalty.rewards.find((reward) => !reward.eligible);
  const share = next ? Math.min(1, loyalty.balance / next.pointsRequired) : 1;
  const radius = 92;
  const length = 2 * Math.PI * radius;
  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Mon espace"
      className="fixed inset-0 z-50 overflow-y-auto bg-[var(--u-bg)] text-[var(--u-ink)]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.9 }}
    >
      <div className="mx-auto max-w-[560px] px-6 pt-[max(env(safe-area-inset-top),16px)] pb-16">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-full px-3 py-2 text-[14px]"
          >
            Fermer
          </button>
        </div>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.2, delay: 0.2 }}
          className="mt-4 text-center text-[34px] font-light"
          style={serif}
        >
          Votre carte
        </motion.p>

        <div className="relative mx-auto mt-8 size-[220px]">
          <svg
            viewBox="0 0 220 220"
            className="size-full -rotate-90"
            aria-hidden="true"
          >
            <circle
              cx="110"
              cy="110"
              r={radius}
              fill="none"
              stroke="var(--u-line)"
              strokeWidth="2"
            />
            <motion.circle
              cx="110"
              cy="110"
              r={radius}
              fill="none"
              stroke="var(--u-accent)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={length}
              initial={{ strokeDashoffset: length }}
              animate={{ strokeDashoffset: length * (1 - share) }}
              transition={{
                duration: 2.2,
                delay: 0.5,
                ease: [0.22, 1, 0.36, 1],
              }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span
              className="text-[64px] leading-none font-light tabular-nums"
              style={serif}
            >
              {loyalty.balance}
            </span>
            <span className="mt-1 text-[14px] text-[var(--u-muted)]">
              points
            </span>
          </div>
        </div>
        {next ? (
          <p className="mt-6 text-center text-[15.5px] text-[var(--u-ink)]/85">
            Encore {next.missingPoints} points avant « {next.name} ».
          </p>
        ) : null}

        <div className="mt-12 rounded-[28px] bg-[var(--u-paper)] p-6 text-[var(--u-ink-on-paper)]">
          <p className="text-[14px] opacity-65">Prochain moment</p>
          <p
            className="mt-2 text-[28px] leading-tight font-light"
            style={serif}
          >
            {booked ? booked.service.name : "Aucun rendez-vous prévu"}
          </p>
          {booked ? (
            <p className="mt-1 text-[15px] opacity-80">
              {booked.day} · {booked.time} ·{" "}
              {minutes(booked.service.durationMinutes)}
            </p>
          ) : null}
        </div>

        <p className="mt-12 text-[14px] text-[var(--u-muted)]">
          Vos récompenses
        </p>
        <ul className="mt-3 flex flex-col gap-3">
          {loyalty.rewards.map((reward) => (
            <li
              key={reward.id}
              className="flex items-center justify-between rounded-[22px] border border-[var(--u-line)] px-5 py-4"
            >
              <span className="text-[17px]">{reward.name}</span>
              <span className="text-[14px] text-[var(--u-muted)] tabular-nums">
                {reward.eligible ? "Prête" : `${reward.pointsRequired} pts`}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-[13.5px] leading-relaxed text-[var(--u-muted)]">
          Les récompenses se demandent à la maison, lors d’un soin.
        </p>
      </div>
    </motion.div>
  );
}

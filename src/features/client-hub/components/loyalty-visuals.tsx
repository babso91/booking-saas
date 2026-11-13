"use client";

import { useEffect, useState } from "react";

import { SparkIcon } from "@/components/ui/icons";
import type {
  ClientHubLoyaltyDto,
  ClientHubRewardDto,
} from "@/features/client-hub/types";
import { cn } from "@/lib/cn";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";

import { points } from "../client/format";

/**
 * Where the customer stands: the closest reward she has not reached yet,
 * and how many are within reach. Information only (the contract's
 * `eligible` and `missingPoints`): she redeems nothing herself.
 */
export function standing(loyalty: ClientHubLoyaltyDto) {
  const reachable = loyalty.rewards.filter((reward) => reward.eligible);
  const next =
    loyalty.rewards
      .filter((reward) => !reward.eligible)
      .sort((a, b) => a.missingPoints - b.missingPoints)[0] ?? null;
  return { reachable, next };
}

/** Share of the way to a reward (0 to 1). */
export function progress(balance: number, reward: ClientHubRewardDto) {
  if (reward.pointsRequired <= 0) return 1;
  return Math.min(1, Math.max(0, balance / reward.pointsRequired));
}

/** The number counting up to its value once (not with reduced motion). */
function useCountUp(value: number) {
  const reduced = useReducedMotion();
  const animate = !reduced && value > 0;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!animate) return;
    let frame = 0;
    const start = performance.now();
    const length = Math.min(1100, 400 + value * 3);
    const step = (at: number) => {
      const t = Math.min(1, (at - start) / length);
      setShown(Math.round(value * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [animate, value]);
  return animate ? shown : value;
}

/**
 * The loyalty card of one business: dark espresso, paper grain, the balance
 * in display figures, and the road to the next reward.
 */
export function BalanceCard({
  businessName,
  loyalty,
  size = "lg",
}: {
  businessName: string;
  loyalty: ClientHubLoyaltyDto;
  size?: "md" | "lg";
}) {
  const shown = useCountUp(loyalty.balance);
  const { reachable, next } = standing(loyalty);
  const share = next
    ? progress(loyalty.balance, next)
    : reachable.length
      ? 1
      : 0;
  const unit = Math.abs(loyalty.balance) > 1 ? "points" : "point";

  return (
    <div
      className={cn(
        "grain relative isolate overflow-hidden bg-ink text-paper-raised shadow-[0_34px_70px_-34px_rgba(35,28,24,0.75)]",
        size === "lg" ? "rounded-[30px] p-6 sm:p-8" : "rounded-[24px] p-5",
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 -right-20 -z-10 size-72 rounded-full bg-[radial-gradient(circle_at_center,rgba(242,226,216,0.32),transparent_65%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-32 -left-24 -z-10 size-80 rounded-full bg-[radial-gradient(circle_at_center,rgba(151,73,58,0.55),transparent_62%)]"
      />

      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-[12px] font-semibold tracking-[0.16em] text-paper-raised/60 uppercase">
            Carte fidélité
          </span>
          <span className="truncate text-[14.5px] font-medium text-paper-raised/90">
            {businessName}
          </span>
        </div>
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-paper-raised/20 text-accent-soft"
        >
          <SparkIcon size={17} />
        </span>
      </div>

      <p
        className={cn(
          "flex items-baseline gap-2",
          size === "lg" ? "mt-7" : "mt-5",
        )}
      >
        <span className="sr-only">Solde : {points(loyalty.balance)}</span>
        <span
          aria-hidden="true"
          className={cn(
            "font-display leading-[0.85] tracking-[-0.02em] tabular-nums",
            size === "lg" ? "text-[76px] sm:text-[92px]" : "text-[56px]",
          )}
        >
          {loyalty.balance < 0 ? "−" : ""}
          {Math.abs(shown).toLocaleString("fr-FR")}
        </span>
        <span aria-hidden="true" className="text-[18px] text-paper-raised/65">
          {unit}
        </span>
      </p>

      {!loyalty.programActive ? (
        <p className="mt-4 inline-flex rounded-full bg-paper-raised/12 px-3 py-1 text-[12.5px] font-medium text-paper-raised/85">
          Programme de fidélité en pause
        </p>
      ) : next || reachable.length ? (
        <div className="mt-5 flex flex-col gap-2.5">
          <div
            role="progressbar"
            aria-label={
              next ? `Progression vers ${next.name}` : "Récompenses disponibles"
            }
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(share * 100)}
            className="h-2 overflow-hidden rounded-full bg-paper-raised/15"
          >
            <span
              className="block h-full origin-left animate-[grow_900ms_var(--ease-out-soft)_both] rounded-full bg-[linear-gradient(90deg,var(--accent-soft),#fff7f1)]"
              style={{ width: `${Math.max(share * 100, 4)}%` }}
            />
          </div>
          <p className="text-[13.5px] leading-snug text-paper-raised/80">
            {reachable.length && !next ? (
              `${reachable.length === 1 ? "Une récompense est disponible" : `${reachable.length} récompenses sont disponibles`} : demandez-la lors de votre prochain rendez-vous.`
            ) : next ? (
              <>
                Plus que{" "}
                <strong className="font-semibold text-paper-raised">
                  {points(next.missingPoints)}
                </strong>{" "}
                avant « {next.name} ».
              </>
            ) : null}
          </p>
          {reachable.length && next ? (
            <p className="text-[13px] text-accent-soft">
              {reachable.length === 1
                ? "1 récompense déjà disponible"
                : `${reachable.length} récompenses déjà disponibles`}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-[13.5px] text-paper-raised/75">
          Aucune récompense proposée pour le moment.
        </p>
      )}
    </div>
  );
}

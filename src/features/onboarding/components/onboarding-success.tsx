"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

import { ArrowRightIcon } from "@/components/ui/icons";
import type { SetupProgressDto } from "@/features/businesses/data/setup-progress";
import { cn } from "@/lib/cn";

import { SetupChecklist } from "./setup-checklist";

const petals = Array.from({ length: 10 }, (_, index) => index * 36);

/**
 * Rendered by /app/welcome with the business and its setup progress read
 * from the server. Online booking is not available yet: the next steps are
 * configuring services and hours, then adding appointments in the agenda.
 */
export function OnboardingSuccess({
  businessName,
  progress,
}: {
  businessName: string;
  progress: SetupProgressDto;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const firstStep =
    progress.activeServices === 0
      ? { href: "/app/services" as const, label: "Ajouter mes prestations" }
      : progress.openingRanges === 0
        ? {
            href: "/app/settings/hours" as const,
            label: "Configurer mes horaires",
          }
        : { href: "/app" as const, label: "Accéder à mon agenda" };

  return (
    <div className="flex flex-col items-center text-center">
      <div
        className="relative flex size-28 items-center justify-center"
        aria-hidden="true"
      >
        {petals.map((angle, index) => (
          <span
            key={angle}
            className={cn(
              "petal absolute top-1/2 left-1/2 -mt-1 -ml-1 size-2 rounded-full",
              index % 3 === 0
                ? "bg-accent"
                : index % 3 === 1
                  ? "bg-line-strong"
                  : "bg-success",
            )}
            style={{
              ["--angle" as string]: `${angle}deg`,
              animationDelay: `${280 + index * 18}ms`,
            }}
          />
        ))}
        <svg width="96" height="96" viewBox="0 0 56 56" className="relative">
          <circle cx="28" cy="28" r="25" fill="var(--success-soft)" />
          <circle
            cx="28"
            cy="28"
            r="25"
            fill="none"
            stroke="var(--success)"
            strokeWidth="1.6"
            className="draw-ring"
            transform="rotate(-90 28 28)"
          />
          <path
            d="M18.5 28.5l6.3 6.3L38 21.5"
            fill="none"
            stroke="var(--success)"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="draw-check"
            style={{ animationDelay: "420ms" }}
          />
        </svg>
      </div>

      <p className="mt-8 animate-rise text-[12.5px] font-semibold tracking-[0.16em] text-accent uppercase [animation-delay:300ms]">
        {businessName}
      </p>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mt-3 animate-rise font-display text-[44px] leading-[1.02] tracking-[-0.015em] text-ink outline-none [animation-delay:360ms] sm:text-[54px]"
      >
        Ton espace est prêt.
      </h1>
      <p className="mt-4 max-w-[38ch] animate-rise text-[16px] leading-relaxed text-ink-soft [animation-delay:420ms]">
        Configure tes prestations et tes horaires, puis ajoute tes rendez-vous
        dans l’agenda.
      </p>

      <div className="mt-8 w-full max-w-[460px] animate-rise [animation-delay:480ms]">
        <SetupChecklist progress={progress} />
      </div>

      <Link
        href={firstStep.href}
        className="group mt-6 inline-flex h-14 w-full max-w-[460px] animate-rise items-center justify-center gap-2.5 rounded-2xl bg-ink text-base font-medium text-paper-raised shadow-[0_10px_24px_-12px_rgb(var(--shadow-rgb)/0.55)] transition-[background-color,transform] duration-200 [animation-delay:540ms] hover:bg-[color-mix(in_srgb,var(--ink)_86%,var(--paper))] active:scale-[0.985]"
      >
        {firstStep.label}
        <ArrowRightIcon
          size={18}
          className="transition-transform duration-200 group-hover:translate-x-0.5"
        />
      </Link>
      {firstStep.href !== "/app" ? (
        <Link
          href="/app"
          className="mt-3 animate-rise text-[14.5px] text-ink-soft underline decoration-line-strong underline-offset-4 [animation-delay:560ms] hover:text-ink"
        >
          Plus tard : aller à mon agenda
        </Link>
      ) : null}
    </div>
  );
}

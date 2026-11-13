"use client";

import Link from "next/link";
import { useId, useState } from "react";

import { CheckIcon } from "@/components/ui/icons";
import { formatPrice } from "@/features/agenda/client/money";
import { plans } from "@/features/experience/studio/plans";
import { cn } from "@/lib/cn";

import {
  priceOf,
  savingLabel,
  type Cadence,
  type OfferDto,
  type PlanCode,
} from "./offers";

// Her offer: the plan she is on and what it allows (both real: sites.plan
// and the Studio's own lens), then, only when offers are listed, the two
// plans side by side with their price by month or by year. No subscription
// is taken here: changing plan is not open online yet, and the page says so.

/** What each plan lets her do, in the Studio's own terms (plans.ts). */
const includes: Record<PlanCode, string[]> = {
  core: [
    "Les trois univers dessinés : Mila, Alma, Nail Lab",
    "Ton nom, tes textes, tes photos et leur cadrage",
    "Les palettes de ton univers, avec ta couleur d’accent",
    "La couleur de ton bouton de réservation",
    "Publication, historique et restauration des versions",
  ],
  signature: [
    "Tout Core",
    "L’ordre et la variante de chaque scène",
    "La typographie, le traitement des photos et les formes",
    "Les transitions et le rythme de ton site",
    "Une palette entièrement libre, vérifiée pour rester lisible",
  ],
};

export function PlanOverview({
  current,
  offers,
}: {
  /** Her plan as the server keeps it. */
  current: PlanCode;
  /** Offers as listed by the server; null: none listed (prices not shown). */
  offers: OfferDto[] | null;
}) {
  const [cadence, setCadence] = useState<Cadence>("year");
  const titleId = useId();
  const order: PlanCode[] = ["core", "signature"];

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="text-[12.5px] font-semibold tracking-[0.16em] text-ink-muted uppercase">
          Mon offre
        </p>
        <h1 className="font-display text-[34px] leading-[1.05] text-ink sm:text-[42px]">
          {plans[current].name}
          <span className="text-ink-muted"> · mode {plans[current].mode}</span>
        </h1>
        <p className="max-w-prose text-[15px] leading-relaxed text-ink-soft">
          {plans[current].promise}
        </p>
      </header>

      {offers ? (
        <div className="flex flex-col gap-4">
          <div
            role="group"
            aria-label="Facturation"
            className="flex w-fit rounded-full bg-sand p-1"
          >
            {(
              [
                ["month", "Mensuel"],
                ["year", "Annuel"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={cadence === value}
                onClick={() => setCadence(value)}
                className={cn(
                  "h-10 cursor-pointer rounded-full px-5 text-[14px] font-medium transition-colors",
                  cadence === value
                    ? "bg-paper-raised text-ink shadow-sm"
                    : "text-ink-soft hover:text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <h2 id={titleId} className="sr-only">
        Les offres
      </h2>
      <ul aria-labelledby={titleId} className="grid gap-4 md:grid-cols-2">
        {order.map((plan) => {
          const price = offers ? priceOf(offers, plan, cadence) : null;
          const monthly = offers ? priceOf(offers, plan, "month") : null;
          const saving = price
            ? savingLabel(price, monthly?.amountMinor ?? null)
            : null;
          const mine = plan === current;
          return (
            <li
              key={plan}
              aria-current={mine ? "true" : undefined}
              className={cn(
                "relative flex flex-col gap-5 overflow-hidden rounded-[28px] border p-6",
                plan === "signature"
                  ? "border-ink bg-ink text-paper-raised"
                  : "border-line bg-paper-raised text-ink",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <p className="font-display text-[30px] leading-none">
                    {plans[plan].name}
                  </p>
                  <p
                    className={cn(
                      "text-[13.5px]",
                      plan === "signature"
                        ? "text-paper-raised/70"
                        : "text-ink-muted",
                    )}
                  >
                    Mode {plans[plan].mode}
                  </p>
                </div>
                {mine ? (
                  <span
                    className={cn(
                      "rounded-full px-3 py-1 text-[12.5px] font-semibold",
                      plan === "signature"
                        ? "bg-paper-raised text-ink"
                        : "bg-ink text-paper-raised",
                    )}
                  >
                    Ton offre
                  </span>
                ) : null}
              </div>

              {price ? (
                <div className="flex flex-col gap-1" aria-live="polite">
                  <p className="flex items-baseline gap-1.5">
                    <span className="font-display text-[40px] leading-none tabular-nums">
                      {formatPrice(price.amountMinor, price.currency)}
                    </span>
                    <span className="text-[14px] opacity-75">
                      {price.cadence === "year" ? "/ an" : "/ mois"}{" "}
                      {price.displayTaxMode === "ttc" ? "TTC" : "HT"}
                    </span>
                  </p>
                  <p className="text-[13.5px] opacity-75">
                    {price.cadence === "year"
                      ? `Soit ${formatPrice(price.monthlyEquivalentMinor, price.currency)} par mois, réglés en une fois.`
                      : `Soit ${formatPrice(price.yearlyMinor, price.currency)} sur un an.`}
                    {saving ? ` ${saving}.` : ""}
                  </p>
                </div>
              ) : null}

              <ul className="flex flex-col gap-2.5 text-[14.5px]">
                {includes[plan].map((line) => (
                  <li key={line} className="flex items-start gap-2.5">
                    <CheckIcon
                      size={17}
                      className={cn(
                        "mt-0.5 shrink-0",
                        plan === "signature"
                          ? "text-paper-raised"
                          : "text-accent",
                      )}
                    />
                    {line}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-2 rounded-2xl bg-sand/60 px-5 py-4 text-[14px] leading-relaxed text-ink-soft">
        <p className="font-semibold text-ink">
          Changer d’offre n’est pas encore possible en ligne.
        </p>
        <p>
          Passer à Signature ou revenir à Core ne supprime rien : les réglages
          Signature restent enregistrés et reviennent avec l’offre.
          {offers ? " Tarifs indicatifs, susceptibles d’évoluer." : ""}
        </p>
        <Link
          href="/app/site"
          className="w-fit font-semibold text-ink underline decoration-line-strong underline-offset-4"
        >
          Ouvrir mon Studio
        </Link>
      </div>
    </div>
  );
}

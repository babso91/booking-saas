"use client";

import { useState } from "react";

import { ELIGIBLE, memoryOfferQuote, REGULAR } from "./memory-actions";
import { QuoteSummary } from "./quote-summary";

/**
 * The slot's quote on fictional data, kept in this page's memory only: to
 * review it before the backend exists. Nothing is booked or charged.
 * Never part of a real page.
 */
export function QuotePreview() {
  const [server] = useState(() =>
    memoryOfferQuote({ delayMs: 400, now: Date.now }),
  );
  const [slot, setSlot] = useState<string | null>(null);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : données fictives, gardées en mémoire. Rien n’est réservé ni
        payé. Code de test : BIENVENUE10.
      </p>
      {slot ? (
        <>
          <QuoteSummary
            key={slot}
            input={{
              serviceId: "s-gel",
              optionChoiceIds: ["o-art"],
              startsAt: slot,
            }}
            serviceName="Pose gel"
            slotLabel={
              slot === ELIGIBLE
                ? "mardi 17 novembre à 14:00"
                : "mardi 17 novembre à 18:00"
            }
            actions={server.actions}
            onChooseAnotherSlot={() => setSlot(null)}
          />
          <button
            type="button"
            className="w-fit cursor-pointer rounded-full border border-dashed border-line-strong px-4 py-2 text-[13px] text-ink-muted"
            onClick={() => server.useQuota()}
          >
            Outil d’aperçu : épuiser l’offre heure creuse
          </button>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-[26px] text-ink">
            Mardi 17 novembre
          </h1>
          <div className="flex gap-2">
            {[
              [ELIGIBLE, "14:00"],
              [REGULAR, "18:00"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setSlot(value!)}
                className="h-11 cursor-pointer rounded-full border border-line bg-paper-raised px-5 text-[15px] text-ink"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

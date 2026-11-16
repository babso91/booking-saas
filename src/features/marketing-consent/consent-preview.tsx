"use client";

import { useState } from "react";

import {
  ConsentHistory,
  type ConsentEventDto,
} from "./components/consent-history";
import { MarketingOptIn } from "./components/marketing-opt-in";
import { CONSENT_WORDING, noMarketingChoice } from "./wording";

/**
 * The consent's foundation, for review (/apercu/consentement): the question
 * as a client would see it while booking, and a client's history as the
 * professional would read it. Fictional, nothing is sent: the wording is a
 * proposal awaiting legal validation.
 */

const BUSINESS = "Atelier Lune";

const SAMPLE_HISTORY: ConsentEventDto[] = [
  {
    channel: "email",
    state: "granted",
    proofVersion: CONSENT_WORDING.version,
    source: "booking",
    businessName: BUSINESS,
    occurredAt: "2026-09-02T09:14:00Z",
  },
  {
    channel: "sms",
    state: "granted",
    proofVersion: CONSENT_WORDING.version,
    source: "booking",
    businessName: BUSINESS,
    occurredAt: "2026-09-02T09:14:00Z",
  },
  {
    channel: "sms",
    state: "withdrawn",
    proofVersion: null,
    source: "unsubscribe_link",
    businessName: BUSINESS,
    occurredAt: "2026-10-19T18:40:00Z",
  },
];

export function ConsentPreview() {
  const [choice, setChoice] = useState(noMarketingChoice);
  return (
    <main className="min-h-dvh bg-paper px-4 py-8 text-ink sm:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <p className="w-fit rounded-full border border-line-strong px-3 py-1 text-[12.5px] font-semibold tracking-wide text-ink uppercase">
            Proposition non validée · rien n’est collecté
          </p>
          <h1 className="font-display text-[34px] leading-tight">
            Consentement aux offres
          </h1>
          <p className="max-w-[60ch] text-[15px] text-ink-soft">
            Texte {CONSENT_WORDING.version}, en attente de vérification
            juridique. Tant qu’il n’est pas validé, aucune réservation ne pose
            cette question et aucun message commercial ne part.
          </p>
        </header>

        <div className="grid gap-8 lg:grid-cols-2">
          <section
            aria-labelledby="preview-booking"
            className="flex flex-col gap-4"
          >
            <h2
              id="preview-booking"
              className="text-[13px] font-semibold tracking-wide text-ink-muted uppercase"
            >
              Côté cliente, en réservant
            </h2>
            <div className="flex flex-col gap-5 rounded-3xl border border-line bg-paper-raised/60 p-5">
              <p className="text-[15px] text-ink-soft">
                Après ses coordonnées, avant de confirmer :
              </p>
              <MarketingOptIn
                businessName={BUSINESS}
                value={choice}
                onChange={setChoice}
              />
              <p role="status" className="text-[13px] text-ink-muted">
                Ses choix : e-mail {choice.email ? "oui" : "non"}, SMS{" "}
                {choice.sms ? "oui" : "non"}. La réservation passe dans tous les
                cas.
              </p>
            </div>
          </section>

          <section
            aria-labelledby="preview-history"
            className="flex flex-col gap-4"
          >
            <h2
              id="preview-history"
              className="text-[13px] font-semibold tracking-wide text-ink-muted uppercase"
            >
              Côté pro, sur sa fiche
            </h2>
            <div className="flex flex-col gap-4 rounded-3xl border border-line bg-paper-raised/60 p-5">
              <h3 className="font-display text-[22px] leading-tight">
                Offres et nouveautés
              </h3>
              <ConsentHistory events={SAMPLE_HISTORY} />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

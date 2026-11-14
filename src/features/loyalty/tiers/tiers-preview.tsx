"use client";

import { useState } from "react";

import { memoryReferral, sampleProgress } from "./memory-actions";
import { ReferralCard } from "./referral-card";
import { TierProgress } from "./tier-progress";

/** Both readers of the progression, and the client's referral card. */
export function TiersPreview() {
  const [referral] = useState(() => memoryReferral(null, { delayMs: 400 }));
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-5 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : données fictives, réponses en mémoire.
      </p>
      <p className="text-[13px] font-semibold text-ink">Côté cliente</p>
      <TierProgress
        progress={sampleProgress()}
        timezone="Europe/Paris"
        reader="client"
      />
      <ReferralCard
        actions={referral.actions}
        businessName="Atelier Maëlys"
        timezone="Europe/Paris"
      />
      <p className="text-[13px] font-semibold text-ink">Côté professionnelle</p>
      <TierProgress
        progress={sampleProgress({ tierId: "t-gold", currentValue: 7 })}
        timezone="Europe/Paris"
        reader="pro"
      />
    </main>
  );
}

"use client";

import { useState } from "react";

import { businessToday } from "@/features/public-booking/client/business-time";

import { JoinWaitlist } from "./join-waitlist";
import { memoryWaitlist } from "./memory-actions";
import { WaitlistOffer } from "./waitlist-offer";

/**
 * The waitlist's two screens on fictional data, answered in this page's
 * memory: to review them before the backend exists. Never in a real page.
 * `pris`: the offer is taken by someone else when she taps it.
 */
export function WaitlistPreview({
  screen,
  taken,
}: {
  screen: "inscription" | "offre";
  taken: boolean;
}) {
  const [server] = useState(() => {
    const created = memoryWaitlist({}, { delayMs: 450 });
    created.state.takenElsewhere = taken;
    return created;
  });
  const [today] = useState(() => businessToday("Europe/Paris"));
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : données fictives, réponses en mémoire.
      </p>
      {screen === "offre" ? (
        <WaitlistOffer offerId="offer-a" actions={server.actions} />
      ) : (
        <JoinWaitlist
          actions={server.actions}
          businessSlug="atelier-maelys"
          serviceId="s1"
          serviceName="Rehaussement de cils"
          today={today}
          horizonDays={30}
          onDone={() => undefined}
        />
      )}
    </main>
  );
}

"use client";

import { useSearchParams } from "next/navigation";
import { createRef, useState } from "react";

import type { Booking } from "../client/api";
import { BookingConfirmation } from "./booking-confirmation";

// Fictional booking, kept in this page only. Nothing is read or sent.
const booking: Booking = {
  appointmentId: "a-preview",
  startsAt: "2026-11-21T13:30:00.000Z",
  endsAt: "2026-11-21T14:45:00.000Z",
  timezone: "Europe/Paris",
  serviceName: "Pose cil à cil",
  durationMinutes: 75,
  priceCents: 7500,
  options: [
    {
      optionId: "o1",
      question: "Courbure",
      choiceId: "c1",
      label: "Naturelle",
      priceDeltaCents: 0,
      durationDeltaMinutes: 0,
    },
  ],
  currency: "EUR",
  businessName: "Atelier Lune",
  status: "confirmed",
  replayed: false,
};
const policy = "Annulation gratuite jusqu’à 24 h avant le rendez-vous.";

const cases = {
  confirme: { booking, local: "2026-11-21T14:30" },
  rejoue: {
    booking: { ...booking, replayed: true },
    local: "2026-11-21T14:30",
  },
  change: {
    booking: { ...booking, replayed: true, status: "cancelled" as const },
    local: "2026-11-21T14:30",
  },
  deplace: { booking: { ...booking, replayed: true }, local: null },
};

/** Every state of the confirmation ticket, on the sand ground and on paper. */
export function TicketPreview() {
  const asked = useSearchParams().get("cas");
  const key = (asked ?? "confirme") as keyof typeof cases;
  const chosen = cases[key] ?? cases.confirme;
  const [run, setRun] = useState(0);
  return (
    <main className="min-h-dvh bg-sand px-4 py-10">
      <nav className="mx-auto mb-6 flex max-w-[26rem] flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-soft">
        {Object.keys(cases).map((name) => (
          <a
            key={name}
            href={`?cas=${name}`}
            aria-current={name === key ? "page" : undefined}
            className="underline-offset-4 aria-[current=page]:font-semibold aria-[current=page]:text-ink aria-[current=page]:underline"
          >
            {name}
          </a>
        ))}
      </nav>
      <BookingConfirmation
        key={`${key}:${run}`}
        booking={chosen.booking}
        local={chosen.local}
        cancellationPolicy={policy}
        onAnother={() => setRun((n) => n + 1)}
        headingRef={createRef()}
      />
    </main>
  );
}

"use client";

import { useState } from "react";

import { memoryLocationsBooking } from "./memory-actions";
import { PlaceAndPerson } from "./place-and-person";

/**
 * Place, person and slot on fictional data, kept in this page's memory
 * only: to review the journey before the backend exists. No booking is
 * ever made. Never part of a real page.
 */
export function LocationsPreview() {
  const [server] = useState(() => memoryLocationsBooking({ delayMs: 400 }));
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : données fictives, gardées en mémoire. Rien n’est réservé.
      </p>
      <PlaceAndPerson
        serviceId="s-lift"
        serviceName="Rehaussement de cils"
        actions={server.actions}
      />
    </main>
  );
}

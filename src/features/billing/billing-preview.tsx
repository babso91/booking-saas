"use client";

import { useState } from "react";

import { BillingSummary } from "./billing-summary";
import { memoryBilling, sampleSummary } from "./memory-actions";

export type BillingScenario = "actif" | "impaye" | "termine";

/**
 * The billing page on fictional data, kept in this page's memory only: to
 * review it before the backend exists. No provider, no charge, no real
 * invoice. Never part of a real page.
 */
export function BillingPreview({ scenario }: { scenario: BillingScenario }) {
  const [server] = useState(() =>
    memoryBilling({
      delayMs: 400,
      start: sampleSummary(
        scenario === "impaye"
          ? { state: "past_due", graceUntil: "2026-11-21T00:00:00.000Z" }
          : scenario === "termine"
            ? { state: "ended", renewsAt: null }
            : {},
      ),
    }),
  );
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : données fictives, gardées en mémoire. Rien n’est débité.
      </p>
      <BillingSummary actions={server.actions} />
    </main>
  );
}

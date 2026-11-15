"use client";

import { useState } from "react";

import { memorySeries } from "./memory-actions";
import { SeriesPlanner } from "./series-planner";

export type SeriesScenario = "automne" | "printemps" | "conflits";

const scenarios: Record<
  SeriesScenario,
  { first: string; busy?: string[]; horizon?: string }
> = {
  // The recipe's fixtures: Paris, clocks going back, then forward.
  automne: { first: "2026-10-18T02:30" },
  printemps: { first: "2026-03-15T02:30" },
  conflits: {
    first: "2026-11-17T10:00",
    busy: ["2026-12-01T09:00:00.000Z", "2026-12-15T09:00:00.000Z"],
    horizon: "2027-01-10",
  },
};

/**
 * The series planner on fictional data, kept in this page's memory only:
 * to review it before the backend exists. Never part of a real page.
 */
export function SeriesPreview({ scenario }: { scenario: SeriesScenario }) {
  const setup = scenarios[scenario];
  const [server] = useState(() =>
    memorySeries({ busy: setup.busy, horizon: setup.horizon, delayMs: 400 }),
  );
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : données fictives, gardées en mémoire. Aucun rendez-vous n’est
        créé.
      </p>
      <SeriesPlanner
        clientName="Lina"
        rule={{
          clientId: "c-lina",
          serviceId: "s-gel",
          optionChoiceIds: [],
          firstLocalStart: setup.first,
        }}
        actions={server.actions}
      />
    </main>
  );
}

"use client";

import { useState } from "react";

import { memoryPlanChange } from "./memory-actions";
import { PlanChange } from "./plan-change";

/**
 * The plan change on fictional, provisional prices, kept in this page's
 * memory only: to review it before the backend exists. Nothing is ever
 * charged. Never part of a real page.
 */
export function PlanChangePreview() {
  const [server] = useState(() =>
    memoryPlanChange({ delayMs: 400, now: Date.now }),
  );
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : prix provisoires, gardés en mémoire. Rien n’est débité.
      </p>
      <PlanChange actions={server.actions} />
    </main>
  );
}

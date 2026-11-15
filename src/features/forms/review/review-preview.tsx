"use client";

import { useState } from "react";

import { memoryVisitForms } from "./memory-actions";
import { VisitForms } from "./visit-forms";

/**
 * The forms of a visit, pro side, on fictional data kept in this page's
 * memory only. Nothing is sent to anyone. Never part of a real page.
 */
export function ReviewPreview() {
  const [server] = useState(() =>
    memoryVisitForms({ delayMs: 400, now: Date.now }),
  );
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : données fictives, gardées en mémoire. Rien n’est envoyé.
      </p>
      <VisitForms appointmentId="a-visit" actions={server.actions} />
    </main>
  );
}

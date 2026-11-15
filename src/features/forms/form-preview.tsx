"use client";

import { useState } from "react";

import { ClientForm } from "./client-form";
import type { ClientFormDto } from "./contract";
import { memoryClientForm, sampleFields, sampleForm } from "./memory-actions";

export type FormScenario =
  "ouvert" | "nouvelle-version" | "envoye" | "complet" | "expire" | "annule";

const starts: Record<FormScenario, Partial<ClientFormDto>> = {
  ouvert: {},
  "nouvelle-version": {},
  envoye: {
    status: "submitted",
    canSubmit: false,
    receipt: { receiptId: "r-0", submittedAt: "2026-11-14T09:30:00.000Z" },
  },
  complet: {
    status: "completed",
    canSubmit: false,
    receipt: { receiptId: "r-0", submittedAt: "2026-11-14T09:30:00.000Z" },
  },
  expire: { status: "expired", canSubmit: false },
  annule: { status: "revoked", canSubmit: false },
};

/**
 * The client's form on fictional data, kept in this page's memory only: to
 * review it before the backend exists. Never part of a real page.
 */
export function FormPreview({ scenario }: { scenario: FormScenario }) {
  const [server] = useState(() =>
    memoryClientForm(sampleForm(starts[scenario]), {
      delayMs: 400,
      newerVersion:
        scenario === "nouvelle-version"
          ? {
              templateVersionId: "tv-4",
              fields: [
                sampleFields[0]!,
                sampleFields[1]!,
                sampleFields[2]!,
                {
                  ...sampleFields[4]!,
                  attestationText:
                    "J’ai lu les nouveaux conseils de préparation et je signalerai toute gêne.",
                },
              ],
            }
          : undefined,
    }),
  );
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : données fictives, gardées en mémoire. Rien n’est envoyé.
      </p>
      <ClientForm assignmentId="fa-1" actions={server.actions} />
    </main>
  );
}

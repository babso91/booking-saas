"use client";

import { useState } from "react";

import { memoryTeam } from "./memory-actions";
import { TeamManager } from "./team-manager";

/**
 * The team screen on fictional data, kept in this page's memory only: to
 * review it before the backend exists. Never part of a real page.
 */
export function TeamPreview() {
  const [server] = useState(() => memoryTeam(undefined, { delayMs: 400 }));
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : données fictives, enregistrées en mémoire. Aucune invitation
        n’est réellement envoyée.
      </p>
      <TeamManager actions={server.actions} />
    </main>
  );
}

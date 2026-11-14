"use client";

import { useState } from "react";

import { memoryRetention } from "./memory-actions";
import { RetentionTable } from "./retention-table";

/**
 * The retention table on fictional figures, kept in this page's memory
 * only: to review it before the backend exists. Never part of a real page.
 */
export function RetentionPreview() {
  const [server] = useState(() => memoryRetention({ delayMs: 400 }));
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : chiffres fictifs, arrêtés au 14 novembre 2026.
      </p>
      <RetentionTable actions={server.actions} />
    </main>
  );
}

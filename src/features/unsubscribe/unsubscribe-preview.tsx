"use client";

import { useState } from "react";

import { memoryUnsubscribe } from "./memory-actions";
import { UnsubscribePage } from "./unsubscribe-page";

/**
 * The unsubscribe page on fictional links, kept in this page's memory
 * only: to review it before the backend exists. Never part of a real page.
 */
export function UnsubscribePreview({ token }: { token: string }) {
  const [server] = useState(() => memoryUnsubscribe({ delayMs: 400 }));
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 px-4 py-10 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : liens fictifs, gardés en mémoire.
      </p>
      <UnsubscribePage token={token} actions={server.actions} />
    </main>
  );
}

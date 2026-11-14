"use client";

import { useState } from "react";

import { AtelierProject } from "./atelier-project";
import { memoryAtelier } from "./memory-actions";

/**
 * The Atelier order on fictional data, kept in this page's memory only: to
 * review it before the backend exists. Nothing is billed or published.
 * Never part of a real page.
 */
export function AtelierPreview() {
  const [server] = useState(() => memoryAtelier({ delayMs: 400 }));
  const [key, setKey] = useState(0);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : données fictives, gardées en mémoire. Rien n’est facturé ni
        publié.
      </p>
      <AtelierProject
        key={key}
        orderId="AT1"
        actions={server.actions}
        studioHref="#"
      />
      <button
        type="button"
        className="w-fit cursor-pointer rounded-full border border-dashed border-line-strong px-4 py-2 text-[13px] text-ink-muted"
        onClick={() => {
          server.editDraft();
          setKey((n) => n + 1);
        }}
      >
        Outil d’aperçu : modifier mon brouillon dans le Studio
      </button>
    </main>
  );
}

"use client";

import { useState } from "react";

import { ExportPanel } from "./export-panel";
import { memoryCrmExport } from "./memory-actions";

/**
 * The export panel on fictional data, kept in this page's memory only: to
 * review it before the backend exists. No file is produced or opened.
 * Never part of a real page.
 */
export function ExportPreview() {
  const [server] = useState(() =>
    memoryCrmExport({ delayMs: 400, now: Date.now }),
  );
  const [tick, setTick] = useState(0);
  const [opened, setOpened] = useState(false);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : données fictives, gardées en mémoire. Aucun fichier n’est
        produit.
      </p>
      <ExportPanel
        actions={server.actions}
        refreshKey={tick}
        onOpen={() => setOpened(true)}
      />
      {opened ? (
        <p className="text-[13px] text-ink-muted" role="status">
          Aperçu : un lien privé aurait été ouvert ici.
        </p>
      ) : null}
      <button
        type="button"
        className="w-fit cursor-pointer rounded-full border border-dashed border-line-strong px-4 py-2 text-[13px] text-ink-muted"
        onClick={() => {
          server.finish();
          setTick((n) => n + 1);
        }}
      >
        Outil d’aperçu : terminer la préparation
      </button>
    </main>
  );
}

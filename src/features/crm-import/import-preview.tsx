"use client";

import { useState } from "react";

import { ImportWizard } from "./import-wizard";
import { memoryCrmImport, sampleCsv } from "./memory-actions";

/**
 * The import wizard on fictional clients, kept in this page's memory only:
 * to review it before the backend exists. Nothing is written anywhere.
 * Never part of a real page.
 */
export function ImportPreview() {
  const [server] = useState(() => memoryCrmImport({ delayMs: 400 }));
  const sample = `data:text/csv;charset=utf-8,${encodeURIComponent(sampleCsv)}`;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : clientes fictives, gardées en mémoire. Rien n’est enregistré.{" "}
        <a
          href={sample}
          download="exemple-clientes.csv"
          className="font-semibold text-ink underline underline-offset-4"
        >
          Fichier d’exemple
        </a>
      </p>
      <ImportWizard actions={server.actions} />
    </main>
  );
}

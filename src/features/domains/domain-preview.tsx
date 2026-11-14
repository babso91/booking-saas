"use client";

import { useState } from "react";

import { DomainSettings } from "./domain-settings";
import { memorySiteDomain } from "./memory-actions";

/**
 * Her domain on a scripted DNS, kept in this page's memory only: to review
 * the steps before the backend exists. Nothing is resolved, bought or
 * issued. Never part of a real page.
 */
export function DomainPreview() {
  const [server] = useState(() =>
    memorySiteDomain({
      delayMs: 500,
      now: Date.now,
      taken: ["pris.example.test"],
    }),
  );
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : DNS simulé, gardé en mémoire. Aucun domaine n’est acheté, lu ni
        certifié. « pris.example.test » simule un domaine déjà relié ailleurs.
      </p>
      <DomainSettings actions={server.actions} />
    </main>
  );
}

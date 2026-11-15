"use client";

import { useState } from "react";

import { FormEditor } from "./form-editor";
import { memoryFormEditor } from "./memory-editor";

/**
 * The template editor on fictional data, kept in this page's memory only:
 * to review it before the backend exists. Never part of a real page.
 */
export function EditorPreview() {
  const [server] = useState(() =>
    memoryFormEditor(undefined, { delayMs: 400 }),
  );
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 px-4 py-8 sm:px-6">
      <p className="text-[13px] text-ink-muted">
        Aperçu : données fictives, gardées en mémoire. Rien n’est publié.
      </p>
      <FormEditor
        templateId="ft-lift"
        businessName="Atelier Maëlys"
        actions={server.actions}
      />
    </main>
  );
}

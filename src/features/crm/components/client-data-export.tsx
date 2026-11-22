"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";

import { exportClientDataAction } from "../actions/client-export";

/** "Inès Martin" → "ines-martin", for a file name. */
const fileSlug = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "cliente";

/**
 * Her right of access (Higani point 205): everything the business holds
 * about her, downloaded as one JSON file the professional can send her.
 */
export function ClientDataExport({
  clientId,
  displayName,
}: {
  clientId: string;
  displayName: string;
}) {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const busy = useRef(false);

  async function download() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setDone(false);
    setError(null);
    try {
      const result = await callAction(() =>
        exportClientDataAction({ clientId }),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const file = new Blob([JSON.stringify(result.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `donnees-${fileSlug(displayName)}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDone(true);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="client-data-export"
      className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised p-4 sm:p-5"
    >
      <h3
        id="client-data-export"
        className="text-[15px] font-semibold text-ink"
      >
        Ses données personnelles
      </h3>
      <p className="text-sm text-ink-muted">
        Si {displayName} te demande les informations que tu as sur elle,
        exporte-les ici : fiche, rendez-vous, notes, consentements, fidélité,
        formulaires et e-mails envoyés, dans un fichier que tu peux lui
        transmettre. Le fichier contient aussi tes notes sur elle.
      </p>
      <Button
        type="button"
        size="md"
        variant="secondary"
        state={pending ? "loading" : "idle"}
        loadingLabel="Préparation du fichier…"
        onClick={() => void download()}
        className="self-start"
      >
        Exporter ses données
      </Button>
      {done ? <Notice tone="success">Fichier téléchargé.</Notice> : null}
      {error ? (
        <Notice tone="error">{describeError(error).message}</Notice>
      ) : null}
    </section>
  );
}

"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Notice } from "@/components/ui/notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";

import {
  eraseClientDataAction,
  exportClientDataAction,
} from "../actions/client-export";
import { getClientRecordAction } from "../actions/client-management";

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
  onErased,
}: {
  clientId: string;
  displayName: string;
  /** Her record changed: read it again. */
  onErased?: () => void;
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
        formulaires, avis et e-mails envoyés, dans un fichier que tu peux lui
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
      <ClientErasure
        clientId={clientId}
        displayName={displayName}
        onErased={onErased}
      />
    </section>
  );
}

/** Her right to erasure, behind an explicit confirmation. */
function ClientErasure({
  clientId,
  displayName,
  onErased,
}: {
  clientId: string;
  displayName: string;
  onErased?: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<"erased" | "already" | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const busy = useRef(false);

  async function erase() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      // The record as it is now: erased only if nobody changed it since.
      const record = await callAction(() =>
        getClientRecordAction({ clientId }),
      );
      if (!record.ok) {
        setError(record.error);
        return;
      }
      const result = await callAction(() =>
        eraseClientDataAction({
          clientId,
          expectedVersion: record.data.version,
        }),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOutcome(result.data.erased ? "erased" : "already");
      setAsking(false);
      onErased?.();
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      <p className="text-sm text-ink-muted">
        Si elle demande l’effacement de ses données : son nom, ses coordonnées,
        tes notes, ses réponses aux formulaires, ses consentements, son avis et
        son accès à l’espace client sont effacés. Ses rendez-vous passés restent
        dans ton historique, sans nom ni coordonnées. C’est impossible tant
        qu’elle a un rendez-vous à venir.
      </p>
      <Button
        type="button"
        size="md"
        variant="ghost"
        onClick={() => {
          setError(null);
          setOutcome(null);
          setAsking(true);
        }}
        className="self-start"
      >
        Effacer ses données
      </Button>
      {outcome === "erased" ? (
        <Notice tone="success">
          Données effacées. La fiche reste dans ton historique sous le nom «
          Cliente effacée ».
        </Notice>
      ) : outcome === "already" ? (
        <Notice tone="success">Ses données étaient déjà effacées.</Notice>
      ) : null}
      {error && !asking ? (
        <Notice tone="error">{describeError(error).message}</Notice>
      ) : null}
      <ConfirmDialog
        open={asking}
        title={`Effacer définitivement les données de ${displayName} ?`}
        description="Son nom, ses coordonnées, tes notes, ses réponses aux formulaires, ses consentements, son avis et son accès à l’espace client seront effacés. Ses rendez-vous passés et leurs montants restent, sans nom ni coordonnées. Aucun e-mail ne lui est envoyé. C’est irréversible."
        confirmLabel="Effacer définitivement"
        tone="danger"
        state={pending ? "loading" : "idle"}
        onConfirm={() => void erase()}
        onCancel={() => setAsking(false)}
      >
        {error ? (
          <Notice tone="error">{describeError(error).message}</Notice>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

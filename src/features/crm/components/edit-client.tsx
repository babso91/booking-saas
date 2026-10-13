"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import {
  getClientRecordAction,
  updateClientAction,
} from "@/features/crm/actions/client-management";
import type {
  ClientRecordDto,
  UpdateClientResultDto,
} from "@/features/crm/types";

import {
  changedElsewhere,
  checkContact,
  contactCommand,
  contactFieldErrors,
  focusFirstError,
  contactLabels,
  draftFromRecord,
  rebaseDraft,
  sameContact,
  type ContactDraft,
  type ContactField,
} from "../client/contact-form";
import { ContactFields } from "./contact-fields";
import { CrmError } from "./crm-error";

const linkAction =
  "cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

/**
 * Edits a customer's identity and contact on the version the form read.
 * What is typed (the draft) is kept apart from the record: closing the
 * sheet, a failed save, a record changed elsewhere or re-read never erase
 * it; only a confirmed save or the professional's own choice does. While
 * a save is pending the fields are read only and the sheet stays open, so
 * nothing typed meanwhile can be dropped by the confirmation.
 */
export function EditClientSheet({
  clientId,
  open,
  onClose,
  onSaved,
  onDraftChange,
}: {
  clientId: string;
  open: boolean;
  onClose: () => void;
  onSaved: (result: UpdateClientResultDto) => void;
  /** Whether unsaved changes are kept for later. */
  onDraftChange: (pending: boolean) => void;
}) {
  /** The record the draft is based on (its version guards the save). */
  const [record, setRecord] = useState<ClientRecordDto | null>(null);
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const [loadError, setLoadError] = useState<UiError | null>(null);
  const [loadRun, setLoadRun] = useState(0);
  const [errors, setErrors] = useState<Partial<Record<ContactField, string>>>(
    {},
  );
  const [failure, setFailure] = useState<UiError | null>(null);
  const [state, setState] = useState<ButtonState>("idle");
  /** The record as it is now, read after a `stale_client`. */
  const [current, setCurrent] = useState<
    | { status: "loading" }
    | { status: "ready"; record: ClientRecordDto }
    | { status: "error"; error: UiError }
    | null
  >(null);
  const alive = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);
  /** Generation of record reads: only the latest one is applied. */
  const reads = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const values = draft ?? (record ? draftFromRecord(record) : null);
  const pending =
    record !== null &&
    draft !== null &&
    !sameContact(draft, draftFromRecord(record));

  useEffect(() => {
    onDraftChange(pending);
  }, [pending, onDraftChange]);

  // Opening reads the record (and its version) unless a draft is kept on
  // the one already read: its version is checked when saving.
  const needsRecord = open && record === null;
  useEffect(() => {
    if (!needsRecord) return;
    const read = (reads.current += 1);
    void callAction(() => getClientRecordAction({ clientId })).then(
      (result) => {
        if (!alive.current || read !== reads.current) return;
        if (result.ok) {
          setRecord(result.data);
          setLoadError(null);
        } else {
          setLoadError(result.error);
        }
      },
    );
    return () => {
      reads.current += 1;
    };
  }, [needsRecord, clientId, loadRun]);

  function close() {
    if (state !== "idle") return;
    // Nothing typed: the next opening reads the record again.
    if (!pending) {
      setRecord(null);
      setDraft(null);
    }
    setFailure(null);
    setCurrent(null);
    setErrors({});
    onClose();
  }

  function change(field: ContactField, value: string) {
    // Locked while saving: a late event never changes what was sent.
    if (!values || state !== "idle") return;
    setDraft({ ...values, [field]: value });
    setErrors((existing) => ({ ...existing, [field]: undefined }));
  }

  async function save() {
    if (state !== "idle" || !record || !values) return;
    const found = checkContact(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstError(formRef.current, found);
      return;
    }
    if (sameContact(values, draftFromRecord(record)) && failure === null) {
      close();
      return;
    }
    setFailure(null);
    setState("loading");
    const result = await callAction(() =>
      updateClientAction({
        clientId,
        expectedVersion: record.version,
        ...contactCommand(values),
      }),
    );
    if (!alive.current) return;
    setState("idle");
    if (result.ok) {
      setRecord(null);
      setDraft(null);
      setCurrent(null);
      onSaved(result.data);
      onClose();
      return;
    }
    const refused = contactFieldErrors(result.error);
    setErrors(refused);
    focusFirstError(formRef.current, refused);
    if (result.error.code !== "validation_error" || !result.error.fieldErrors) {
      setFailure(result.error);
    }
  }

  function compare() {
    setCurrent({ status: "loading" });
    const read = (reads.current += 1);
    void callAction(() => getClientRecordAction({ clientId })).then(
      (result) => {
        if (!alive.current || read !== reads.current) return;
        setCurrent(
          result.ok
            ? { status: "ready", record: result.data }
            : { status: "error", error: result.error },
        );
      },
    );
  }

  /** Keeps what was typed, on the version read now: saving is explicit. */
  function keepMine(latest: ClientRecordDto) {
    if (!values || !record) return;
    // Fields left untouched take their current value (never reverted).
    setDraft(rebaseDraft(record, latest, values));
    setRecord(latest);
    setCurrent(null);
    setFailure(null);
  }

  /** Drops what was typed for the version read now. */
  function takeTheirs(latest: ClientRecordDto) {
    setRecord(latest);
    setDraft(null);
    setCurrent(null);
    setFailure(null);
    setErrors({});
  }

  function discard() {
    setDraft(null);
    setRecord(null);
    setFailure(null);
    setCurrent(null);
    setErrors({});
    onClose();
  }

  const busy = state !== "idle";

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Modifier la fiche"
      description="Les rendez-vous déjà réservés gardent le contact indiqué à leur réservation."
      footer={
        values ? (
          // Two rows, so every action fits the panel (460px on desktop):
          // the main actions, then the destructive one on its own line.
          <div className="flex flex-col gap-2">
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" size="md" onClick={close} disabled={busy}>
                {pending ? "Garder pour plus tard" : "Annuler"}
              </Button>
              <Button
                type="submit"
                form="edit-client"
                size="md"
                state={state}
                loadingLabel="Enregistrement…"
                // Wide enough for "Enregistrement…" while saving.
                className="sm:min-w-36"
                disabled={failure?.code === "stale_client"}
              >
                Enregistrer
              </Button>
            </div>
            {pending ? (
              <Button
                variant="ghost"
                size="md"
                onClick={discard}
                disabled={busy}
                className="sm:self-start"
              >
                <span className="text-danger">
                  Abandonner mes modifications
                </span>
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {values ? (
        <form
          id="edit-client"
          ref={formRef}
          aria-busy={busy}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="flex flex-col gap-5 pt-1"
        >
          {pending && failure === null && current === null ? (
            <p className="text-[13.5px] text-ink-muted">
              Modifications non enregistrées.
            </p>
          ) : null}
          <ContactFields
            value={values}
            onChange={change}
            errors={errors}
            readOnly={busy}
          />

          {failure?.code === "stale_client" && record ? (
            <StaleRecord
              base={record}
              current={current}
              typed={values}
              onCompare={compare}
              onKeepMine={keepMine}
              onTakeTheirs={takeTheirs}
            />
          ) : failure ? (
            <SaveFailure error={failure} onRetry={() => void save()} />
          ) : null}
        </form>
      ) : loadError ? (
        <CrmError
          error={loadError}
          onRetry={() => {
            setLoadError(null);
            setLoadRun((value) => value + 1);
          }}
        >
          {loadError.code === "unauthenticated"
            ? undefined
            : "La fiche n’a pas pu être chargée pour modification."}
        </CrmError>
      ) : (
        <div className="flex flex-col gap-4" aria-busy="true">
          <span className="sr-only" role="status">
            Chargement de la fiche…
          </span>
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="h-14 animate-pulse rounded-2xl bg-sand/70"
            />
          ))}
        </div>
      )}
    </Sheet>
  );
}

function StaleRecord({
  base,
  current,
  typed,
  onCompare,
  onKeepMine,
  onTakeTheirs,
}: {
  base: ClientRecordDto;
  current:
    | { status: "loading" }
    | { status: "ready"; record: ClientRecordDto }
    | { status: "error"; error: UiError }
    | null;
  typed: ContactDraft;
  onCompare: () => void;
  onKeepMine: (latest: ClientRecordDto) => void;
  onTakeTheirs: (latest: ClientRecordDto) => void;
}) {
  if (current?.status === "ready") {
    const latest = current.record;
    const changes = changedElsewhere(base, latest, typed);
    return (
      <Notice tone="warning" title="Version actuelle de la fiche">
        {changes.length === 0 ? (
          <p>
            Les coordonnées n’ont pas changé ailleurs : seule la fiche a été
            mise à jour.
          </p>
        ) : (
          <dl className="mt-1 flex flex-col gap-2">
            {changes.map((change) => (
              <div key={change.field} className="flex flex-col">
                <dt className="font-semibold">{contactLabels[change.field]}</dt>
                <dd className="wrap-anywhere">
                  Maintenant : {change.current || "non renseigné"}
                </dd>
                <dd className="wrap-anywhere">
                  {change.edited
                    ? `Ta saisie : ${change.typed || "non renseigné"}`
                    : "Tu ne l’avais pas modifié : la valeur actuelle sera gardée."}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          <button
            type="button"
            onClick={() => onKeepMine(latest)}
            className={linkAction}
          >
            {changes.some((change) => change.edited) || changes.length === 0
              ? "Garder ma saisie"
              : "Garder mes modifications"}
          </button>
          <button
            type="button"
            onClick={() => onTakeTheirs(latest)}
            className={linkAction}
          >
            Reprendre la version actuelle
          </button>
        </div>
      </Notice>
    );
  }
  return (
    <Notice
      tone="warning"
      title="Fiche modifiée ailleurs"
      action={
        current?.status === "loading" ? (
          <span className="text-[14px]">
            Chargement de la version actuelle…
          </span>
        ) : (
          <button type="button" onClick={onCompare} className={linkAction}>
            Voir la version actuelle
          </button>
        )
      }
    >
      {current?.status === "error"
        ? "La version actuelle n’a pas pu être chargée. Ta saisie est conservée : réessaie."
        : "Cette fiche a changé pendant que tu la modifiais. Rien n’a été enregistré et ta saisie est conservée : compare-la à la version actuelle avant de choisir."}
    </Notice>
  );
}

function SaveFailure({
  error,
  onRetry,
}: {
  error: UiError;
  onRetry: () => void;
}) {
  switch (error.code) {
    case "client_email_conflict":
      return (
        <Notice
          tone="warning"
          title="Cet email est déjà celui d’une cliente"
          action={
            error.conflict ? (
              <Link
                href={`/app/clients/${error.conflict.clientId}`}
                className={linkAction}
              >
                Ouvrir la fiche existante
              </Link>
            ) : undefined
          }
        >
          {error.conflict
            ? `Il appartient à la fiche de ${error.conflict.displayName}. Rien n’a été modifié : les deux fiches restent séparées.`
            : "Rien n’a été modifié : les deux fiches restent séparées."}
        </Notice>
      );
    case "network":
      return (
        <Notice
          tone="offline"
          title="Connexion interrompue"
          action={
            <button type="button" onClick={onRetry} className={linkAction}>
              Réessayer
            </button>
          }
        >
          Les modifications ont peut-être été enregistrées. Réessaie : les mêmes
          valeurs ne sont jamais enregistrées deux fois.
        </Notice>
      );
    case "client_not_found":
      return (
        <CrmError error={error}>
          Cette fiche n’existe plus : elle a pu être fusionnée ou supprimée.
        </CrmError>
      );
    case "validation_error":
      return (
        <CrmError error={error}>
          Vérifie les informations saisies puis réessaie.
        </CrmError>
      );
    default:
      return (
        <CrmError error={error} onRetry={onRetry}>
          {error.code === "unauthenticated"
            ? undefined
            : "Les modifications n’ont pas pu être enregistrées. Ta saisie est conservée."}
        </CrmError>
      );
  }
}

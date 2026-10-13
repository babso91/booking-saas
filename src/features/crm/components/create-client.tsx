"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import {
  fingerprintOf,
  requestKeyFor,
  type RequestKey,
} from "@/features/agenda/client/request-id";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { createClientAction } from "@/features/crm/actions/client-management";

import {
  checkContact,
  contactCommand,
  contactFieldErrors,
  focusFirstError,
  EMPTY_CONTACT,
  type ContactDraft,
  type ContactField,
} from "../client/contact-form";
import { ContactFields } from "./contact-fields";
import { CrmError } from "./crm-error";

/**
 * Creates a customer by hand. One idempotency key per command: a retry of
 * the same values (lost answer, double tap) reuses it, so the backend never
 * creates the customer twice; changed values are a new command with a new
 * key. While it is sent the fields are read only (what is sent is what
 * is saved) and the sheet cannot be dismissed. Success is only announced
 * once the backend confirmed it, and the new record opens right away. An email already used is never merged: the screen
 * offers to open that customer instead.
 */
export function CreateClientSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<ContactDraft>(EMPTY_CONTACT);
  const [errors, setErrors] = useState<Partial<Record<ContactField, string>>>(
    {},
  );
  const [failure, setFailure] = useState<UiError | null>(null);
  const [state, setState] = useState<ButtonState>("idle");
  const key = useRef<RequestKey | null>(null);
  const alive = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function change(field: ContactField, value: string) {
    // Locked while sent: a late event never changes the submitted values.
    if (state !== "idle") return;
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  /** `fresh`: the professional chose to send these values as a new command. */
  async function submit(fresh = false) {
    if (state !== "idle") return;
    const found = checkContact(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstError(formRef.current, found);
      return;
    }

    const command = contactCommand(draft);
    key.current = fresh
      ? { fingerprint: fingerprintOf(command), id: crypto.randomUUID() }
      : requestKeyFor(key.current, fingerprintOf(command));
    const requestId = key.current.id;
    setFailure(null);
    setState("loading");

    const result = await callAction(() =>
      createClientAction({ ...command, requestId }),
    );
    if (!alive.current) return;
    if (result.ok) {
      setState("success");
      key.current = null;
      // Mounted and confirmed: open the new record now (no timer that
      // could outlive this page and override a later navigation).
      router.push(`/app/clients/${result.data.client.id}`);
      return;
    }
    setState("idle");
    const refused = contactFieldErrors(result.error);
    setErrors(refused);
    focusFirstError(formRef.current, refused);
    if (result.error.code !== "validation_error" || !result.error.fieldErrors) {
      setFailure(result.error);
    }
  }

  const busy = state !== "idle";

  return (
    <Sheet
      open={open}
      onClose={() => (busy ? undefined : onClose())}
      title="Ajouter une cliente"
      description="Seul le prénom est obligatoire. Tu pourras compléter la fiche plus tard."
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" size="md" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button
            type="submit"
            form="create-client"
            size="md"
            state={state}
            loadingLabel="Création…"
            successLabel="Fiche créée"
          >
            Créer la fiche
          </Button>
        </div>
      }
    >
      <form
        id="create-client"
        ref={formRef}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        aria-busy={state === "loading"}
        className="flex flex-col gap-5 pt-1"
      >
        <ContactFields
          value={draft}
          onChange={change}
          errors={errors}
          readOnly={busy}
        />

        {failure ? (
          <CreateFailure
            error={failure}
            onRetry={() => void submit()}
            onSendAsNew={() => void submit(true)}
          />
        ) : null}

        <p className="sr-only" role="status">
          {state === "success" ? "Fiche créée. Ouverture de la fiche…" : ""}
        </p>
      </form>
    </Sheet>
  );
}

const linkAction =
  "cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

function CreateFailure({
  error,
  onRetry,
  onSendAsNew,
}: {
  error: UiError;
  onRetry: () => void;
  onSendAsNew: () => void;
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
            ? `Il appartient à la fiche de ${error.conflict.displayName}. Rien n’a été créé : ouvre sa fiche, ou change l’email pour créer une autre cliente.`
            : "Rien n’a été créé : change l’email pour créer une autre cliente."}
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
          La fiche a peut-être été créée. Réessaie sans changer les informations
          : elle ne sera pas créée deux fois.
        </Notice>
      );
    case "idempotency_conflict":
      return (
        <Notice
          tone="warning"
          title="Rien n’a été créé"
          action={
            <button type="button" onClick={onSendAsNew} className={linkAction}>
              Créer avec ces informations
            </button>
          }
        >
          Ce formulaire a déjà servi à créer une fiche avec d’autres
          informations. Vérifie dans la liste qu’elle n’existe pas déjà avant de
          créer celle-ci.
        </Notice>
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
            : "La fiche n’a pas pu être créée. Ce que tu as saisi est conservé."}
        </CrmError>
      );
  }
}

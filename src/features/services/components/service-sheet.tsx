"use client";

import { useEffect, useRef, useState } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import {
  fingerprintOf,
  requestKeyFor,
  type RequestKey,
} from "@/features/agenda/client/request-id";
import {
  callAction,
  type UiError,
  type UiResult,
} from "@/features/auth/client/call-action";
import {
  createServiceAction,
  updateServiceAction,
} from "@/features/services/actions/services";

import {
  checkService,
  draftFromService,
  durationLabel,
  EMPTY_SERVICE,
  MAX_DESCRIPTION,
  MAX_NAME,
  serviceChanges,
  serviceFieldErrors,
  type ServiceDraft,
  type ServiceField,
  type ServiceView,
} from "../client/service-form";

const FIELD_ORDER: ServiceField[] = [
  "name",
  "description",
  "duration",
  "price",
];

const linkAction =
  "cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

/** Which form is open: a new service, or an existing one. */
export type ServiceSheetTarget =
  { mode: "create" } | { mode: "edit"; service: ServiceView };

/**
 * Creates or edits a service. Drafts are kept per target while the page is
 * open (closing never loses them). While a save is pending the fields are
 * read only, the sheet cannot be dismissed and nothing is sent twice; success
 * is only shown once the backend confirmed it. A creation carries one
 * request id per command, so a resend never creates twice; a lost answer is
 * still reconciled against the list first (to be retired by the UI pass,
 * docs/SETUP_WRITE_GUARANTEES_HANDOFF.md).
 */
export function ServiceSheet({
  target,
  currency,
  onClose,
  onSaved,
  onGone,
  reconcileCreate,
}: {
  target: ServiceSheetTarget | null;
  currency: string;
  onClose: () => void;
  onSaved: (service: ServiceView, created: boolean) => void;
  /** The edited service no longer exists. */
  onGone: () => void;
  /** After a lost answer: the service created by this command, if any. */
  reconcileCreate: (command: {
    name: string;
    durationMinutes: number;
    priceCents: number;
  }) => Promise<ServiceView | null>;
}) {
  const [drafts] = useState(() => new Map<string, ServiceDraft>());
  const [saving, setSaving] = useState(false);
  const key = target
    ? target.mode === "create"
      ? "new"
      : target.service.id
    : null;
  return (
    <Sheet
      open={target !== null}
      onClose={() => (saving ? undefined : onClose())}
      title={
        target?.mode === "edit"
          ? "Modifier la prestation"
          : "Nouvelle prestation"
      }
      description={
        target?.mode === "edit"
          ? "Les rendez-vous déjà pris gardent le nom, la durée et le prix enregistrés à leur réservation."
          : "Elle sera proposée dans l’agenda dès son enregistrement."
      }
    >
      {target && key ? (
        <ServiceForm
          key={key}
          target={target}
          draftKey={key}
          drafts={drafts}
          currency={currency}
          onSavingChange={setSaving}
          onClose={onClose}
          onSaved={onSaved}
          onGone={onGone}
          reconcileCreate={reconcileCreate}
        />
      ) : null}
    </Sheet>
  );
}

function ServiceForm({
  target,
  draftKey,
  drafts,
  currency,
  onSavingChange,
  onClose,
  onSaved,
  onGone,
  reconcileCreate,
}: {
  target: ServiceSheetTarget;
  draftKey: string;
  drafts: Map<string, ServiceDraft>;
  currency: string;
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
  onSaved: (service: ServiceView, created: boolean) => void;
  onGone: () => void;
  reconcileCreate: (command: {
    name: string;
    durationMinutes: number;
    priceCents: number;
  }) => Promise<ServiceView | null>;
}) {
  const initial =
    target.mode === "edit" ? draftFromService(target.service) : EMPTY_SERVICE;
  const [draft, setDraft] = useState<ServiceDraft>(
    () => drafts.get(draftKey) ?? initial,
  );
  const [errors, setErrors] = useState<Partial<Record<ServiceField, string>>>(
    {},
  );
  const [failure, setFailure] = useState<UiError | null>(null);
  const [state, setState] = useState<ButtonState>("idle");
  const alive = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);
  /** The last creation's answer was lost: check the list before resending. */
  const unsure = useRef(false);
  /** One request id per creation command: a resend never creates twice. */
  const requestKey = useRef<RequestKey | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Never leave the sheet locked once this form is gone.
  useEffect(() => () => onSavingChange(false), [onSavingChange]);

  const busy = state !== "idle";
  const pending = FIELD_ORDER.some((field) => draft[field] !== initial[field]);

  function change(field: ServiceField, value: string) {
    // Locked while saving: a late event never changes what was sent.
    if (busy) return;
    const next = { ...draft, [field]: value };
    setDraft(next);
    setErrors((current) => ({ ...current, [field]: undefined }));
    if (FIELD_ORDER.some((name) => next[name] !== initial[name])) {
      drafts.set(draftKey, next);
    } else {
      drafts.delete(draftKey);
    }
  }

  function focusFirstError(found: Partial<Record<ServiceField, string>>) {
    const index = FIELD_ORDER.findIndex((field) => found[field]);
    if (index < 0) return;
    formRef.current
      ?.querySelectorAll<HTMLElement>("input, textarea")
      [index]?.focus();
  }

  async function save() {
    if (busy) return;
    const checked = checkService(draft);
    if (!checked.ok) {
      setErrors(checked.errors);
      focusFirstError(checked.errors);
      return;
    }
    setErrors({});
    const { command } = checked;
    if (target.mode === "edit") {
      const changes = serviceChanges(target.service, command);
      if (Object.keys(changes).length === 0) {
        drafts.delete(draftKey);
        onClose();
        return;
      }
    }
    setFailure(null);
    setState("loading");
    onSavingChange(true);
    const creating = target.mode === "create";
    let saved: ServiceView | null = null;
    let result: UiResult<ServiceView> | null = null;
    // After a lost answer, the creation may have been written: look first.
    // A resend carries the same request id and never creates twice.
    if (creating && unsure.current) saved = await reconcileCreate(command);
    if (!saved) {
      if (creating) {
        requestKey.current = requestKeyFor(
          requestKey.current,
          fingerprintOf(command),
        );
      }
      const requestId = requestKey.current?.id;
      result = await callAction(() =>
        target.mode === "edit"
          ? updateServiceAction({
              serviceId: target.service.id,
              expectedVersion: target.service.version,
              changes: serviceChanges(target.service, command),
            })
          : createServiceAction({ ...command, requestId }),
      );
      if (result.ok) saved = result.data;
      else if (creating && result.error.code === "network") {
        saved = await reconcileCreate(command);
      }
    }
    unsure.current =
      creating &&
      !saved &&
      result?.ok === false &&
      result.error.code === "network";
    if (!alive.current) return;
    setState("idle");
    onSavingChange(false);
    if (saved) {
      drafts.delete(draftKey);
      onSaved(saved, target.mode === "create");
      onClose();
      return;
    }
    if (result && !result.ok) {
      const refused = serviceFieldErrors(result.error.fieldErrors);
      setErrors(refused);
      focusFirstError(refused);
      if (result.error.code === "not_found") onGone();
      if (
        result.error.code !== "validation_error" ||
        Object.keys(refused).length === 0
      ) {
        setFailure(result.error);
      }
    }
  }

  function discard() {
    drafts.delete(draftKey);
    onClose();
  }

  const minutes = /^\d+$/.test(draft.duration.trim())
    ? Number(draft.duration)
    : null;
  const symbol =
    new Intl.NumberFormat("fr-FR", { style: "currency", currency })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? currency;

  return (
    <form
      ref={formRef}
      noValidate
      aria-busy={state === "loading"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="flex flex-col gap-5 pt-1"
    >
      <TextField
        label="Nom"
        value={draft.name}
        onChange={(event) => change("name", event.target.value)}
        error={errors.name}
        readOnly={busy}
        maxLength={MAX_NAME}
        autoComplete="off"
        placeholder="Rehaussement de cils"
        data-autofocus=""
      />
      <TextAreaField
        label="Description"
        optional
        value={draft.description}
        onChange={(event) => change("description", event.target.value)}
        error={errors.description}
        readOnly={busy}
        counterMax={MAX_DESCRIPTION}
        rows={3}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Durée"
          value={draft.duration}
          onChange={(event) => change("duration", event.target.value)}
          error={errors.duration}
          readOnly={busy}
          inputMode="numeric"
          autoComplete="off"
          trailing={
            <span className="pr-3 text-[15px] text-ink-muted">min</span>
          }
          hint={minutes && minutes >= 5 ? durationLabel(minutes) : "En minutes"}
        />
        <TextField
          label="Prix"
          value={draft.price}
          onChange={(event) => change("price", event.target.value)}
          error={errors.price}
          readOnly={busy}
          inputMode="decimal"
          autoComplete="off"
          placeholder="45"
          trailing={
            <span className="pr-3 text-[15px] text-ink-muted">{symbol}</span>
          }
        />
      </div>

      {failure ? (
        <SaveFailure
          error={failure}
          creating={target.mode === "create"}
          onRetry={() => void save()}
        />
      ) : null}

      <div className="sticky -bottom-6 -mx-5 -mb-6 flex flex-col gap-2 border-t border-line bg-paper-raised px-5 pt-3 pb-[max(env(safe-area-inset-bottom),1.25rem)] sm:-mx-6 sm:px-6">
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" size="md" onClick={onClose} disabled={busy}>
            {pending ? "Garder pour plus tard" : "Annuler"}
          </Button>
          <Button
            type="submit"
            size="md"
            state={state}
            loadingLabel="Enregistrement…"
            className="sm:min-w-36"
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
            <span className="text-danger">Abandonner mes modifications</span>
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function SaveFailure({
  error,
  creating,
  onRetry,
}: {
  error: UiError;
  creating: boolean;
  onRetry: () => void;
}) {
  switch (error.code) {
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
          {creating
            ? "La prestation n’apparaît pas encore dans ta liste. Réessaie : ta liste sera vérifiée avant tout nouvel envoi. Ta saisie est conservée."
            : "La modification a peut-être été enregistrée. Réessaie : les mêmes valeurs ne changent rien."}
        </Notice>
      );
    case "not_found":
      return (
        <Notice tone="warning" title="Prestation introuvable">
          Elle a été supprimée entre-temps. Ta saisie est conservée : tu peux la
          recopier dans une nouvelle prestation.
        </Notice>
      );
    case "unauthenticated":
      return (
        <Notice
          tone="error"
          title="Session expirée"
          action={
            <a href="/login" className={linkAction}>
              Me reconnecter
            </a>
          }
        >
          Reconnecte-toi pour enregistrer. Ta saisie reste ici tant que la page
          est ouverte.
        </Notice>
      );
    case "validation_error":
      return (
        <Notice tone="error" title="À vérifier">
          Certaines informations ont été refusées. Vérifie-les puis réessaie.
        </Notice>
      );
    default:
      return (
        <Notice
          tone="error"
          title="Enregistrement impossible"
          action={
            <button type="button" onClick={onRetry} className={linkAction}>
              Réessayer
            </button>
          }
        >
          La prestation n’a pas pu être enregistrée. Ta saisie est conservée.
        </Notice>
      );
  }
}

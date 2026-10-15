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
import { callAction, type UiError } from "@/features/auth/client/call-action";
import {
  scopeId,
  type DraftScope,
} from "@/features/businesses/client/draft-scope";
import {
  createServiceAction,
  updateServiceAction,
} from "@/features/services/actions/services";

import {
  clearServiceDraft,
  creationKey,
  editKey,
  readEditDraft,
  readPendingCreation,
  writeEditDraft,
  writePendingCreation,
} from "../client/service-drafts";
import {
  checkService,
  draftFromService,
  durationLabel,
  EMPTY_SERVICE,
  MAX_DESCRIPTION,
  MAX_NAME,
  rebaseServiceDraft,
  serviceChanges,
  serviceChangedElsewhere,
  serviceFieldErrors,
  serviceFieldLabels,
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
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

/** Which form is open: a new service, or an existing one. */
export type ServiceSheetTarget =
  { mode: "create" } | { mode: "edit"; service: ServiceView };

/** The service as it is now, read after a refused edit. */
export type CurrentService =
  | { status: "found"; service: ServiceView }
  | { status: "gone" }
  | { status: "error"; error: UiError };

const sameDraft = (a: ServiceDraft, b: ServiceDraft) =>
  FIELD_ORDER.every((field) => a[field] === b[field]);

/**
 * Creates or edits a service (docs/SETUP_WRITE_GUARANTEES_HANDOFF.md).
 *
 * - Creation: one request id per command. A resend of the same values
 *   (lost answer, double tap) carries the same id: the backend answers the
 *   service it created, never a second one. The creation in progress
 *   (values, id, unconfirmed answer) is kept for the browser session, so
 *   closing the form or leaving the page never forgets it. A new id is only
 *   used for changed values or by the professional's explicit choice.
 * - Edit: sent with the version it was read at. A service changed elsewhere
 *   (stale_service) is read again and compared field by field; nothing is
 *   sent until the professional chooses. An edit kept for later survives
 *   leaving the page; reopened on a service changed since, it is compared
 *   the same way before anything is sent.
 * - Drafts belong to one identity (user and business): never shown, kept or
 *   sent under another.
 *
 * While a save is pending the fields are read only, the sheet cannot be
 * dismissed and nothing is sent twice; success is only shown once the
 * backend confirmed it.
 */
export function ServiceSheet({
  target,
  currency,
  scope,
  onClose,
  onSaved,
  onGone,
  onReload,
  readCurrent,
}: {
  target: ServiceSheetTarget | null;
  currency: string;
  /** Whose drafts these are (signed-in user and business). */
  scope: DraftScope;
  onClose: () => void;
  onSaved: (service: ServiceView, created: boolean) => void;
  /** The edited service no longer exists. */
  onGone: () => void;
  /** The list should be read again (a creation refused as deleted). */
  onReload: () => void;
  /** The service as it is now (after a refused edit). */
  readCurrent: (serviceId: string) => Promise<CurrentService>;
}) {
  // The creation in progress and the edits kept for later are kept for the
  // session, for this identity only (service-drafts.ts).
  const [saving, setSaving] = useState(false);
  // One form per identity and target: state never carries over from one
  // to the other (the screen is also remounted per identity).
  const formKey = target
    ? `${scopeId(scope)}:${target.mode === "create" ? "new" : target.service.id}`
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
      {target?.mode === "create" ? (
        <CreateForm
          key={formKey}
          storeKey={creationKey(scope)}
          currency={currency}
          onSavingChange={setSaving}
          onClose={onClose}
          onSaved={(service) => onSaved(service, true)}
          onReload={onReload}
        />
      ) : target?.mode === "edit" ? (
        <EditForm
          key={formKey}
          service={target.service}
          storeKey={editKey(scope, target.service.id)}
          currency={currency}
          onSavingChange={setSaving}
          onClose={onClose}
          onSaved={(service) => onSaved(service, false)}
          onGone={onGone}
          readCurrent={readCurrent}
        />
      ) : null}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

function CreateForm({
  storeKey,
  currency,
  onSavingChange,
  onClose,
  onSaved,
  onReload,
}: {
  storeKey: string;
  currency: string;
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
  onSaved: (service: ServiceView) => void;
  onReload: () => void;
}) {
  const [kept] = useState(() => readPendingCreation(storeKey));
  const [draft, setDraft] = useState<ServiceDraft>(
    () => kept?.draft ?? EMPTY_SERVICE,
  );
  /** The request id of the last command sent (kept with the draft). */
  const key = useRef<RequestKey | null>(kept?.key ?? null);
  /** The last answer was lost: the creation may already exist. */
  const [unconfirmed, setUnconfirmed] = useState(kept?.unconfirmed ?? false);
  /** The values of that unconfirmed command (to tell a changed resend). */
  const [sentFingerprint, setSentFingerprint] = useState<string | null>(() =>
    kept?.unconfirmed ? (kept.key?.fingerprint ?? null) : null,
  );
  const [errors, setErrors] = useState<Partial<Record<ServiceField, string>>>(
    {},
  );
  const [failure, setFailure] = useState<UiError | null>(null);
  const [state, setState] = useState<ButtonState>("idle");
  const alive = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => () => onSavingChange(false), [onSavingChange]);

  const busy = state !== "idle";
  const pending = !sameDraft(draft, EMPTY_SERVICE) || unconfirmed;
  const checked = checkService(draft);
  // Values changed since the unconfirmed command: saving is a new creation.
  const changedSinceUnconfirmed =
    unconfirmed &&
    sentFingerprint !== null &&
    checked.ok &&
    fingerprintOf(checked.command) !== sentFingerprint;

  function keep(next: { draft: ServiceDraft; unconfirmed: boolean }) {
    if (sameDraft(next.draft, EMPTY_SERVICE) && !next.unconfirmed) {
      clearServiceDraft(storeKey);
    } else {
      writePendingCreation(storeKey, { ...next, key: key.current });
    }
  }

  function change(field: ServiceField, value: string) {
    // Locked while saving: a late event never changes what was sent.
    if (busy) return;
    const next = { ...draft, [field]: value };
    setDraft(next);
    setErrors((current) => ({ ...current, [field]: undefined }));
    // "Resend without changing anything" no longer applies: the notice
    // above says whether saving is still the same creation.
    if (unconfirmed) setFailure(null);
    keep({ draft: next, unconfirmed });
  }

  /** `fresh`: a new request id, by the professional's explicit choice. */
  async function save(fresh = false) {
    if (busy) return;
    const found = checkService(draft);
    if (!found.ok) {
      setErrors(found.errors);
      focusFirstError(formRef.current, found.errors);
      return;
    }
    setErrors({});
    const { command } = found;
    const fingerprint = fingerprintOf(command);
    // Same values: same request id (never a second service). Changed
    // values, or an explicit choice: a new command.
    key.current = fresh
      ? { fingerprint, id: crypto.randomUUID() }
      : requestKeyFor(key.current, fingerprint);
    const requestId = key.current.id;
    // Kept as unconfirmed while in flight: an answer that never reaches
    // this form (page left, identity switched, tab closed) is offered back
    // as such, and resent with the same request id.
    keep({ draft, unconfirmed: true });
    setFailure(null);
    setState("loading");
    onSavingChange(true);
    const result = await callAction(() =>
      createServiceAction({ ...command, requestId }),
    );
    if (!alive.current) return;
    setState("idle");
    onSavingChange(false);
    if (result.ok) {
      key.current = null;
      clearServiceDraft(storeKey);
      onSaved(result.data);
      onClose();
      return;
    }
    const error = result.error;
    const lost = error.code === "network" || error.code === "internal";
    // A lost answer: the creation may exist. Its resend keeps the same id.
    setUnconfirmed(lost);
    setSentFingerprint(lost ? fingerprint : null);
    keep({ draft, unconfirmed: lost });
    if (error.code === "service_deleted") onReload();
    const refused = serviceFieldErrors(error.fieldErrors);
    setErrors(refused);
    focusFirstError(formRef.current, refused);
    if (
      error.code !== "validation_error" ||
      Object.keys(refused).length === 0
    ) {
      setFailure(error);
    }
  }

  function discard() {
    key.current = null;
    clearServiceDraft(storeKey);
    onClose();
  }

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
      {unconfirmed && !failure ? (
        <Notice tone="warning" title="Création non confirmée">
          {changedSinceUnconfirmed
            ? "Tu as modifié la prestation depuis l’envoi non confirmé : l’enregistrer en créera une nouvelle. Si la première avait été enregistrée, elle apparaîtra aussi dans ta liste."
            : "La connexion s’était interrompue. Enregistre à nouveau sans rien changer : si la prestation avait déjà été créée, elle ne le sera pas une seconde fois."}
        </Notice>
      ) : null}

      <ServiceFields
        draft={draft}
        errors={errors}
        busy={busy}
        currency={currency}
        onChange={change}
      />

      {failure ? (
        <CreateFailure
          error={failure}
          onRetry={() => void save()}
          onSendAsNew={() => void save(true)}
          onDiscard={discard}
        />
      ) : null}

      <Footer
        state={state}
        pending={pending}
        onClose={onClose}
        onDiscard={discard}
        discardLabel="Abandonner cette prestation"
      />
    </form>
  );
}

function CreateFailure({
  error,
  onRetry,
  onSendAsNew,
  onDiscard,
}: {
  error: UiError;
  onRetry: () => void;
  onSendAsNew: () => void;
  onDiscard: () => void;
}) {
  const choices = (
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      <button type="button" onClick={onSendAsNew} className={linkAction}>
        La créer comme nouvelle prestation
      </button>
      <button type="button" onClick={onDiscard} className={linkAction}>
        Abandonner
      </button>
    </div>
  );
  switch (error.code) {
    case "network":
    case "internal":
      return (
        <Notice
          tone={error.code === "network" ? "offline" : "error"}
          title="Création non confirmée"
          action={
            <button type="button" onClick={onRetry} className={linkAction}>
              Réessayer
            </button>
          }
        >
          La prestation a peut-être été créée. Réessaie sans rien changer : le
          même envoi ne crée jamais deux prestations. Ta saisie est conservée,
          même si tu fermes ce formulaire.
        </Notice>
      );
    case "idempotency_conflict":
      return (
        <Notice tone="warning" title="Rien n’a été créé" action={choices}>
          Cet envoi avait déjà servi à créer une prestation différente. Vérifie
          ta liste : si celle-ci n’y est pas, tu peux la créer comme nouvelle
          prestation.
        </Notice>
      );
    case "service_deleted":
      return (
        <Notice
          tone="warning"
          title="Prestation supprimée depuis"
          action={choices}
        >
          Cette prestation avait déjà été créée, puis supprimée : elle n’a pas
          été recréée. Ta liste a été actualisée.
        </Notice>
      );
    default:
      return <CommonFailure error={error} onRetry={onRetry} />;
  }
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

function EditForm({
  service,
  storeKey,
  currency,
  onSavingChange,
  onClose,
  onSaved,
  onGone,
  readCurrent,
}: {
  service: ServiceView;
  /** Where this edit is kept for later (this identity, this service). */
  storeKey: string;
  currency: string;
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
  onSaved: (service: ServiceView) => void;
  onGone: () => void;
  readCurrent: (serviceId: string) => Promise<CurrentService>;
}) {
  const [kept] = useState(() => readEditDraft(storeKey, service.id));
  // A kept draft started from an older version: compare before saving.
  const outdated = kept !== null && kept.base.version !== service.version;
  const [draft, setDraft] = useState<ServiceDraft>(
    () => kept?.draft ?? draftFromService(service),
  );
  /** The service (and version) the draft is based on. */
  const [base, setBase] = useState<ServiceView>(() => kept?.base ?? service);
  const [errors, setErrors] = useState<Partial<Record<ServiceField, string>>>(
    {},
  );
  const [failure, setFailure] = useState<UiError | null>(
    outdated ? { code: "stale_service" } : null,
  );
  const [current, setCurrent] = useState<
    CurrentService | { status: "loading" } | null
  >(outdated ? { status: "found", service } : null);
  const [state, setState] = useState<ButtonState>("idle");
  const alive = useRef(true);
  const reads = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => () => onSavingChange(false), [onSavingChange]);

  const busy = state !== "idle";
  const pending = !sameDraft(draft, draftFromService(base));
  const stale = failure?.code === "stale_service";

  function keep(next: ServiceDraft, from: ServiceView) {
    if (sameDraft(next, draftFromService(from))) clearServiceDraft(storeKey);
    else writeEditDraft(storeKey, { draft: next, base: from });
  }

  function change(field: ServiceField, value: string) {
    if (busy) return;
    const next = { ...draft, [field]: value };
    setDraft(next);
    setErrors((existing) => ({ ...existing, [field]: undefined }));
    keep(next, base);
  }

  function compare() {
    setCurrent({ status: "loading" });
    const read = (reads.current += 1);
    void readCurrent(service.id).then((found) => {
      if (!alive.current || read !== reads.current) return;
      setCurrent(found);
      if (found.status === "gone") onGone();
    });
  }

  async function save() {
    if (busy || stale) return;
    const found = checkService(draft);
    if (!found.ok) {
      setErrors(found.errors);
      focusFirstError(formRef.current, found.errors);
      return;
    }
    setErrors({});
    // Only what the professional changed, on the version it was read at.
    const changes = serviceChanges(base, found.command);
    if (Object.keys(changes).length === 0) {
      clearServiceDraft(storeKey);
      onClose();
      return;
    }
    setFailure(null);
    setCurrent(null);
    setState("loading");
    onSavingChange(true);
    const result = await callAction(() =>
      updateServiceAction({
        serviceId: service.id,
        expectedVersion: base.version,
        changes,
      }),
    );
    if (!alive.current) return;
    setState("idle");
    onSavingChange(false);
    if (result.ok) {
      clearServiceDraft(storeKey);
      onSaved(result.data);
      onClose();
      return;
    }
    const error = result.error;
    const refused = serviceFieldErrors(error.fieldErrors);
    setErrors(refused);
    focusFirstError(formRef.current, refused);
    if (error.code === "not_found") onGone();
    if (
      error.code !== "validation_error" ||
      Object.keys(refused).length === 0
    ) {
      setFailure(error);
    }
    // Changed elsewhere: read it now, to compare.
    if (error.code === "stale_service") compare();
  }

  /** Keeps what was typed on the version read now (others take it). */
  function keepMine(latest: ServiceView) {
    const next = rebaseServiceDraft(base, latest, draft);
    setDraft(next);
    setBase(latest);
    keep(next, latest);
    setFailure(null);
    setCurrent(null);
  }

  /** Drops what was typed for the version read now. */
  function takeTheirs(latest: ServiceView) {
    const next = draftFromService(latest);
    setDraft(next);
    setBase(latest);
    clearServiceDraft(storeKey);
    setFailure(null);
    setCurrent(null);
    setErrors({});
  }

  function discard() {
    clearServiceDraft(storeKey);
    onClose();
  }

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
      <ServiceFields
        draft={draft}
        errors={errors}
        busy={busy}
        currency={currency}
        onChange={change}
      />

      {stale ? (
        <StaleService
          base={base}
          current={current}
          typed={draft}
          onCompare={compare}
          onKeepMine={keepMine}
          onTakeTheirs={takeTheirs}
        />
      ) : failure?.code === "not_found" || current?.status === "gone" ? (
        <Notice tone="warning" title="Prestation supprimée entre-temps">
          Elle n’existe plus. Ta saisie est conservée : tu peux la recopier dans
          une nouvelle prestation.
        </Notice>
      ) : failure ? (
        <CommonFailure error={failure} onRetry={() => void save()} />
      ) : null}

      <Footer
        state={state}
        pending={pending}
        saveDisabled={stale}
        onClose={onClose}
        onDiscard={discard}
        discardLabel="Abandonner mes modifications"
      />
    </form>
  );
}

type StaleProps = {
  base: ServiceView;
  current: CurrentService | { status: "loading" } | null;
  typed: ServiceDraft;
  onCompare: () => void;
  onKeepMine: (latest: ServiceView) => void;
  onTakeTheirs: (latest: ServiceView) => void;
};

function StaleService(props: StaleProps) {
  // Below the fields: brought into view, otherwise "Enregistrer" is disabled
  // with no visible reason on a small screen.
  const box = useRef<HTMLDivElement>(null);
  const status = props.current?.status;
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: "nearest" });
  }, [status]);
  return (
    // Clear of the sticky footer.
    <div ref={box} className="scroll-mb-56">
      <StaleNotice {...props} />
    </div>
  );
}

function StaleNotice({
  base,
  current,
  typed,
  onCompare,
  onKeepMine,
  onTakeTheirs,
}: StaleProps) {
  if (current?.status === "found") {
    const latest = current.service;
    const changes = serviceChangedElsewhere(base, latest, typed);
    const mine = changes.some((change) => change.edited);
    return (
      <Notice tone="warning" title="Version actuelle de la prestation">
        {changes.length === 0 ? (
          <p>
            Ses nom, description, durée et prix n’ont pas changé ailleurs
            {latest.active !== base.active
              ? ` : elle a été ${latest.active ? "réactivée" : "désactivée"}.`
              : "."}
          </p>
        ) : (
          <dl className="mt-1 flex flex-col gap-2">
            {changes.map((change) => (
              <div key={change.field} className="flex flex-col">
                <dt className="font-semibold">
                  {serviceFieldLabels[change.field]}
                </dt>
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
        <p className="mt-2">
          Rien n’a été enregistré. Choisis, puis enregistre.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          <button
            type="button"
            onClick={() => onKeepMine(latest)}
            className={linkAction}
          >
            {mine || changes.length === 0
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
      title="Prestation modifiée ailleurs"
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
        : "Cette prestation a changé depuis que tu l’as ouverte. Rien n’a été enregistré et ta saisie est conservée."}
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function focusFirstError(
  form: HTMLFormElement | null,
  found: Partial<Record<ServiceField, string>>,
) {
  const index = FIELD_ORDER.findIndex((field) => found[field]);
  if (index < 0) return;
  form?.querySelectorAll<HTMLElement>("input, textarea")[index]?.focus();
}

function ServiceFields({
  draft,
  errors,
  busy,
  currency,
  onChange,
}: {
  draft: ServiceDraft;
  errors: Partial<Record<ServiceField, string>>;
  busy: boolean;
  currency: string;
  onChange: (field: ServiceField, value: string) => void;
}) {
  const minutes = /^\d+$/.test(draft.duration.trim())
    ? Number(draft.duration)
    : null;
  const symbol =
    new Intl.NumberFormat("fr-FR", { style: "currency", currency })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? currency;
  return (
    <>
      <TextField
        label="Nom"
        value={draft.name}
        onChange={(event) => onChange("name", event.target.value)}
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
        onChange={(event) => onChange("description", event.target.value)}
        error={errors.description}
        readOnly={busy}
        counterMax={MAX_DESCRIPTION}
        rows={3}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Durée"
          value={draft.duration}
          onChange={(event) => onChange("duration", event.target.value)}
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
          onChange={(event) => onChange("price", event.target.value)}
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
    </>
  );
}

function Footer({
  state,
  pending,
  saveDisabled = false,
  onClose,
  onDiscard,
  discardLabel,
}: {
  state: ButtonState;
  pending: boolean;
  saveDisabled?: boolean;
  onClose: () => void;
  onDiscard: () => void;
  discardLabel: string;
}) {
  const busy = state !== "idle";
  return (
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
          disabled={saveDisabled}
          className="sm:min-w-36"
        >
          Enregistrer
        </Button>
      </div>
      {pending ? (
        <Button
          variant="ghost"
          size="md"
          onClick={onDiscard}
          disabled={busy}
          className="sm:self-start"
        >
          <span className="text-danger">{discardLabel}</span>
        </Button>
      ) : null}
    </div>
  );
}

function CommonFailure({
  error,
  onRetry,
}: {
  error: UiError;
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
          La modification a peut-être été enregistrée. Réessaie : les mêmes
          valeurs ne changent rien.
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

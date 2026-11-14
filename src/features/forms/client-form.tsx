"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/cn";

import {
  formErrors,
  type AnswerValue,
  type Answers,
  type ClientFormActions,
  type ClientFormDto,
  type FormFieldDto,
} from "./contract";
import {
  carryOver,
  missingAnswers,
  progressOf,
  pruneHidden,
  visibleFields,
} from "./engine";

// The form a client fills in before her visit, in her Hub. Her answers
// live in this page only (never in the browser's storage); a hidden
// question's answer is cleared the moment it is hidden; the server
// decides what counts, and its receipt is the only proof of sending.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

/** "20 novembre", "1er décembre". */
export function dayLabel(iso: string) {
  const date = new Date(iso);
  const text = new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Paris",
  }).format(date);
  return text.replace(/^1 /, "1er ");
}

type Read =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error" }
  | { status: "ready"; form: ClientFormDto };

export function ClientForm({
  assignmentId,
  actions,
}: {
  assignmentId: string;
  actions: ClientFormActions;
}) {
  const [read, setRead] = useState<Read>({ status: "loading" });
  const [run, setRun] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const requestIds = useRef(new Map<string, string>());
  const carry = useRef<Answers | null>(null);

  useEffect(() => {
    let current = true;
    void actions.read(assignmentId).then((result) => {
      if (!current) return;
      if (!result.ok)
        return setRead({
          status:
            result.error.code === formErrors.notFound ? "missing" : "error",
        });
      if (carry.current) {
        setAnswers(carryOver(result.data.fields, carry.current));
        carry.current = null;
      }
      setRead({ status: "ready", form: result.data });
    });
    return () => {
      current = false;
    };
  }, [actions, assignmentId, run]);

  const open =
    read.status === "ready" &&
    read.form.status === "assigned" &&
    read.form.canSubmit;

  // Leaving with unsent answers asks first; nothing is kept elsewhere.
  useEffect(() => {
    if (!open || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [open, dirty]);

  if (read.status === "loading")
    return (
      <div role="status" aria-label="Chargement du formulaire…">
        <div className="h-56 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );
  if (read.status === "missing")
    return (
      <Notice tone="info" title="Ce formulaire n’est pas disponible">
        Le lien n’est plus valable ou ne vous concerne pas. Votre praticienne
        peut vous en envoyer un nouveau.
      </Notice>
    );
  if (read.status === "error")
    return (
      <Notice
        tone="error"
        title="Le formulaire n’a pas pu être chargé"
        action={
          <button
            type="button"
            className={linkAction}
            onClick={() => setRun((value) => value + 1)}
          >
            Réessayer
          </button>
        }
      >
        Rien n’a été envoyé.
      </Notice>
    );

  const { form } = read;
  const header = (
    <header className="flex flex-col gap-2">
      <p className="text-[13px] font-medium tracking-[0.08em] text-ink-muted uppercase">
        {form.businessName}
      </p>
      <h1 className="font-display text-[30px] leading-tight text-ink">
        {form.title}
      </h1>
      {open && form.intro ? (
        <p className="max-w-prose text-[15px] leading-relaxed text-ink-soft">
          {form.intro}
        </p>
      ) : null}
    </header>
  );

  if (!open)
    return (
      <div className="flex flex-col gap-5">
        {header}
        <Closed form={form} />
      </div>
    );

  const shown = visibleFields(form.fields, answers);
  const progress = progressOf(form.fields, answers);

  function answer(fieldId: string, value: AnswerValue) {
    setDirty(true);
    setNotice(null);
    setAnswers((current) =>
      pruneHidden(form.fields, { ...current, [fieldId]: value }),
    );
    setErrors((current) => {
      if (!(fieldId in current)) return current;
      const next = { ...current };
      delete next[fieldId];
      return next;
    });
  }

  function focusField(fieldId: string) {
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-field="${fieldId}"] input`)
        ?.focus(),
    );
  }

  async function submit() {
    if (busy) return;
    const kept = pruneHidden(form.fields, answers);
    const missing = missingAnswers(form.fields, kept);
    setErrors(missing);
    const first = shown.find((field) => field.id in missing);
    if (first) {
      setNotice(null);
      return focusField(first.id);
    }
    const body = visibleFields(form.fields, kept)
      .filter((field) => field.id in kept)
      .map((field) => ({
        fieldId: field.id,
        value: kept[field.id]!,
        ...(field.type === "attestation"
          ? { attestedText: field.attestationText }
          : {}),
      }));
    const key = `${form.templateVersionId}:${JSON.stringify(body)}`;
    if (!requestIds.current.has(key))
      requestIds.current.set(key, crypto.randomUUID());
    setBusy(true);
    setNotice(null);
    const result = await actions.submit({
      assignmentId: form.assignmentId,
      templateVersionId: form.templateVersionId,
      requestId: requestIds.current.get(key)!,
      answers: body,
    });
    setBusy(false);
    if (result.ok) {
      setDirty(false);
      return setRead({
        status: "ready",
        form: {
          ...form,
          status: result.data.status,
          canSubmit: false,
          receipt: {
            receiptId: result.data.receiptId,
            submittedAt: result.data.submittedAt,
          },
        },
      });
    }
    const { code, fieldId } = result.error;
    if (code === formErrors.stale) {
      carry.current = kept;
      setNotice(
        "Ce formulaire vient d’être mis à jour. Vos réponses qui s’appliquent encore sont gardées : vérifiez-les, puis envoyez de nouveau.",
      );
      return setRun((value) => value + 1);
    }
    if (code === formErrors.expired || code === formErrors.revoked)
      return setRun((value) => value + 1);
    if (code === formErrors.required && fieldId) {
      setErrors({ [fieldId]: "Merci de répondre à cette question." });
      return focusField(fieldId);
    }
    setNotice(
      code === "network"
        ? "Pas de réponse. Réessayez : un même envoi n’est jamais compté deux fois."
        : "L’envoi n’a pas abouti. Réessayez dans un instant.",
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      {form.expiresAt ? (
        <p className="text-[14px] text-ink-soft">
          À remplir avant le {dayLabel(form.expiresAt)}.
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <div
          role="progressbar"
          aria-label="Questions obligatoires remplies"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-valuetext={`${progress.done} sur ${progress.total}`}
          className="h-1.5 overflow-hidden rounded-full bg-sand"
        >
          <div
            className="h-full rounded-full bg-ink transition-[width] duration-300 ease-soft"
            style={{
              width: `${progress.total ? (progress.done / progress.total) * 100 : 100}%`,
            }}
          />
        </div>
        <p className="text-[13px] text-ink-muted" aria-hidden>
          {progress.done} sur {progress.total} questions obligatoires
        </p>
      </div>

      {notice ? (
        <Notice tone="error" title="À revoir">
          {notice}
        </Notice>
      ) : null}

      <form
        noValidate
        className="flex flex-col gap-7"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ol className="flex flex-col gap-7">
          {shown.map((field) => (
            <li key={field.id} data-field={field.id}>
              <Question
                field={field}
                value={answers[field.id]}
                error={errors[field.id]}
                disabled={busy}
                onAnswer={(value) => answer(field.id, value)}
              />
            </li>
          ))}
        </ol>
        <Button
          type="submit"
          size="lg"
          state={busy ? "loading" : "idle"}
          loadingLabel="Envoi…"
        >
          Envoyer mes réponses
        </Button>
        <p className="text-[13px] text-ink-muted">
          Vos réponses ne sont enregistrées qu’à l’envoi. Seule{" "}
          {form.businessName} peut les lire.
        </p>
      </form>
    </div>
  );
}

function Closed({ form }: { form: ClientFormDto }) {
  const sent = form.receipt
    ? `Envoyé le ${dayLabel(form.receipt.submittedAt)}.`
    : null;
  if (form.status === "submitted" || form.status === "under_review")
    return (
      <Notice tone="success" title="Réponses envoyées">
        {sent} {form.businessName} va les relire avant votre venue ; vous n’avez
        rien d’autre à faire.
      </Notice>
    );
  if (form.status === "completed")
    return (
      <Notice tone="success" title="C’est complet">
        {sent} Merci, tout est prêt pour votre venue.
      </Notice>
    );
  if (form.status === "expired")
    return (
      <Notice tone="info" title="Ce formulaire a expiré">
        Le délai pour le remplir est passé. Votre praticienne peut vous en
        envoyer un nouveau si besoin.
      </Notice>
    );
  if (form.status === "revoked")
    return (
      <Notice tone="info" title="Ce formulaire n’est plus demandé">
        Vous n’avez rien à remplir.
      </Notice>
    );
  return (
    <Notice tone="info" title="Pas encore ouvert">
      Ce formulaire ne peut pas être rempli pour le moment.
    </Notice>
  );
}

function Question({
  field,
  value,
  error,
  disabled,
  onAnswer,
}: {
  field: FormFieldDto;
  value: AnswerValue | undefined;
  error: string | undefined;
  disabled: boolean;
  onAnswer: (value: AnswerValue) => void;
}) {
  const id = `field-${field.id}`;
  const optional = field.required ? null : (
    <span className="font-normal text-ink-muted"> (facultatif)</span>
  );

  if (field.type === "short_text")
    return (
      <TextField
        id={id}
        name={id}
        label={field.label}
        optional={!field.required}
        hint={field.help ?? undefined}
        error={error}
        maxLength={500}
        autoComplete="off"
        value={typeof value === "string" ? value : ""}
        readOnly={disabled}
        onChange={(event) => onAnswer(event.target.value)}
      />
    );

  if (field.type === "attestation")
    return (
      <fieldset
        className="flex flex-col gap-2"
        aria-describedby={error ? `${id}-error` : undefined}
      >
        <legend className="mb-2 text-[15px] font-medium text-ink">
          {field.label}
        </legend>
        <label
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3.5 text-[15px] leading-relaxed text-ink",
            error ? "border-danger" : "border-line bg-paper-raised",
          )}
        >
          <input
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            onChange={(event) => onAnswer(event.target.checked)}
            className="mt-1 size-4 shrink-0 accent-[var(--ink)]"
          />
          {field.attestationText}
        </label>
        <FieldError id={`${id}-error`} error={error} />
      </fieldset>
    );

  const choices =
    field.type === "boolean"
      ? [
          { value: true, label: "Oui" },
          { value: false, label: "Non" },
        ]
      : (field.options ?? []).map((option) => ({
          value: option.id,
          label: option.label,
        }));
  const helpId = field.help ? `${id}-help` : null;
  return (
    <fieldset
      className="flex flex-col gap-2"
      aria-describedby={
        [error ? `${id}-error` : null, helpId].filter(Boolean).join(" ") ||
        undefined
      }
    >
      <legend className="text-[15px] font-medium text-ink">
        {field.label}
        {optional}
      </legend>
      {field.help ? (
        <p id={helpId!} className="text-[13.5px] text-ink-muted">
          {field.help}
        </p>
      ) : null}
      <div className="mt-1 flex flex-wrap gap-2">
        {choices.map((choice) => {
          const checked = value === choice.value;
          return (
            <label
              key={String(choice.value)}
              className={cn(
                "relative flex h-11 cursor-pointer items-center rounded-full border px-5 text-[15px] transition-[background-color,border-color,color] duration-200 ease-soft select-none",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                checked
                  ? "border-ink bg-ink text-paper-raised"
                  : error
                    ? "border-danger bg-paper-raised text-ink"
                    : "border-line bg-paper-raised text-ink-soft hover:border-line-strong hover:text-ink",
              )}
            >
              <input
                type="radio"
                name={id}
                checked={checked}
                disabled={disabled}
                onChange={() => onAnswer(choice.value)}
                className="sr-only"
              />
              {choice.label}
            </label>
          );
        })}
      </div>
      <FieldError id={`${id}-error`} error={error} />
    </fieldset>
  );
}

function FieldError({ id, error }: { id: string; error: string | undefined }) {
  if (!error) return null;
  return (
    <p id={id} className="text-[13.5px] font-medium text-danger">
      {error}
    </p>
  );
}

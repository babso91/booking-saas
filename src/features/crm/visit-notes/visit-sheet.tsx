"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import type { UiError } from "@/features/auth/client/call-action";
import { cn } from "@/lib/cn";

import {
  visitNoteErrors,
  type FieldDefinitionDto,
  type TechnicalNoteDto,
  type VisitNotesActions,
  type VisitPreparationDto,
} from "./contract";
import {
  checkSheet,
  copyFrom,
  differences,
  draftOf,
  emptyProduct,
  isEmpty,
  sameContent,
  saveCommand,
  type Difference,
  type SheetDraft,
} from "./draft";

// "Préparer la visite": what she wants to remember about this client, her
// last sheet to start from, her tags, and this visit's technical sheet.
//
// - A sheet is a draft until she validates it. Validated, it is never
//   edited: a correction is a new sheet that says what it replaces and why.
// - Taking an earlier sheet's values over is her decision, said with its
//   origin; fields that no longer exist are named, never copied.
// - Changed elsewhere (`stale_technical_note`): her text stays on screen,
//   the saved sheet is read, and she takes its values field by field.
// - A lost answer is resent with the same request id: nothing is saved or
//   validated twice.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50";

type Read =
  | { status: "loading" }
  | { status: "error"; error: UiError }
  | { status: "ready"; data: VisitPreparationDto };

export function VisitSheet({
  appointmentId,
  actions,
}: {
  appointmentId: string;
  /** Her server; an in-memory one only in a design preview or a test. */
  actions: VisitNotesActions;
}) {
  const [read, setRead] = useState<Read>({ status: "loading" });
  const [run, setRun] = useState(0);

  useEffect(() => {
    let current = true;
    void actions.preparation(appointmentId).then((result) => {
      if (!current) return;
      setRead(
        result.ok
          ? { status: "ready", data: result.data }
          : { status: "error", error: result.error },
      );
    });
    return () => {
      current = false;
    };
  }, [actions, appointmentId, run]);

  if (read.status === "loading")
    return (
      <div role="status" aria-label="Chargement de la visite…">
        <div className="h-40 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );
  if (read.status === "error")
    return (
      <Notice
        tone={read.error.code === "network" ? "offline" : "error"}
        title="La visite n’a pas pu être chargée"
        action={
          <button
            type="button"
            className={linkAction}
            onClick={() => {
              setRead({ status: "loading" });
              setRun((value) => value + 1);
            }}
          >
            Réessayer
          </button>
        }
      >
        Rien n’a été modifié.
      </Notice>
    );
  return (
    <Prepared
      // A new reading of another visit: a fresh sheet.
      key={read.data.appointmentId}
      initial={read.data}
      actions={actions}
    />
  );
}

type Mode = "edit" | "view" | "correct";

function Prepared({
  initial,
  actions,
}: {
  initial: VisitPreparationDto;
  actions: VisitNotesActions;
}) {
  const [prep, setPrep] = useState(initial);
  const fields = prep.allowedFields;
  /** The visit's sheet as the server last answered it. */
  const [note, setNote] = useState<TechnicalNoteDto | null>(initial.current);
  const [mode, setMode] = useState<Mode>(
    initial.current?.state === "recorded" ? "view" : "edit",
  );
  const [draft, setDraft] = useState<SheetDraft>(() =>
    draftOf(initial.current, initial.allowedFields),
  );
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<{
    from: string;
    removed: string[];
  } | null>(null);
  const [conflict, setConflict] = useState<Difference[] | null>(null);
  const [failure, setFailure] = useState<{
    title: string;
    message: string;
    tone: "error" | "offline" | "warning";
  } | null>(null);
  const [saving, setSaving] = useState<"draft" | "record" | null>(null);
  const [done, setDone] = useState<ButtonState>("idle");
  const [tagBusy, setTagBusy] = useState<string | null>(null);
  const ids = useRef(new Map<string, string>());
  const idFor = (key: string) => {
    if (!ids.current.has(key)) ids.current.set(key, crypto.randomUUID());
    return ids.current.get(key)!;
  };

  const savedDraft = note?.state === "draft" ? note : null;
  const baseline = draftOf(
    mode === "correct" && !savedDraft ? null : note,
    fields,
  );
  const dirty = !sameContent(draft, baseline, fields);
  const recorded = note?.state === "recorded" ? note : null;
  const busy = saving !== null;
  const day = (iso: string) =>
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: prep.timezone,
      day: "numeric",
      month: "long",
    }).format(new Date(iso));

  const setValue = (fieldId: string, value: string) => {
    setDraft((current) => ({
      ...current,
      values: { ...current.values, [fieldId]: value },
    }));
    setErrors((current) => without(current, fieldId));
    setFailure(null);
  };

  /** Reads the visit again; her text is kept, compared with what is saved. */
  async function reconcile() {
    const again = await actions.preparation(prep.appointmentId);
    if (!again.ok) {
      setFailure({
        title: "Cette fiche a changé ailleurs",
        message:
          "Elle n’a pas pu être relue. Ta saisie est gardée ici : réessaie.",
        tone: "warning",
      });
      return;
    }
    const theirs = again.data.current;
    setPrep(again.data);
    setNote(theirs);
    if (theirs?.state === "recorded") {
      // Validated elsewhere meanwhile: hers can only be a correction.
      setMode("correct");
      setFailure({
        title: "Une fiche a été validée entre-temps",
        message:
          "Ta saisie est gardée ici. Compare-la ci-dessous, puis valide-la comme correction si elle doit la remplacer.",
        tone: "warning",
      });
    }
    setConflict(
      differences(
        draft,
        draftOf(theirs, again.data.allowedFields),
        again.data.allowedFields,
      ),
    );
  }

  function refused(code: string, what: "draft" | "record") {
    if (code === visitNoteErrors.stale) return void reconcile();
    if (code === visitNoteErrors.clientChanged)
      return setFailure({
        title: "Ce rendez-vous a changé de cliente",
        message:
          "La fiche n’a pas été enregistrée, pour ne pas l’attacher à la mauvaise personne. Recharge la visite.",
        tone: "error",
      });
    if (code === visitNoteErrors.fieldNotAllowed)
      return void reconcile().then(() =>
        setFailure({
          title: "Un champ n’existe plus",
          message:
            "Tes champs ont changé entre-temps : ceux qui restent sont affichés. Vérifie ta fiche, puis enregistre.",
          tone: "warning",
        }),
      );
    setFailure(
      code === "network"
        ? {
            title: "Pas de réponse",
            message:
              "Rien ne dit que c’est enregistré. Réessaie : la même demande ne s’applique jamais deux fois.",
            tone: "offline",
          }
        : {
            title:
              what === "record"
                ? "Fiche non validée"
                : "Brouillon non enregistré",
            message: "Ta saisie est gardée ici. Réessaie dans un instant.",
            tone: "error",
          },
    );
  }

  async function save(thenRecord: boolean) {
    if (busy) return;
    const found = checkSheet(draft, fields);
    if (thenRecord && mode === "correct" && !reason.trim())
      found.reason = "Dis en une phrase ce qui est corrigé.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setFailure(null);
    setDone("idle");

    let current = savedDraft;
    if (dirty || !current) {
      setSaving("draft");
      const command = saveCommand(draft, fields, {
        requestId: "",
        appointmentId: prep.appointmentId,
        expectedVersion: current?.version ?? 0,
        supersedesId: mode === "correct" ? (recorded?.id ?? null) : null,
      });
      const result = await actions.saveDraft({
        ...command,
        // One id per content and version: a retry of the same save reuses it.
        requestId: idFor(`draft:${JSON.stringify(command)}`),
      });
      if (!result.ok) {
        setSaving(null);
        return refused(result.error.code, "draft");
      }
      current = result.data;
      setNote(result.data);
      setConflict(null);
    }
    if (thenRecord) {
      setSaving("record");
      const result = await actions.record({
        requestId: idFor(`record:${current.id}:${current.version}`),
        noteId: current.id,
        expectedVersion: current.version,
        ...(current.supersedesId ? { correctionReason: reason.trim() } : {}),
      });
      if (!result.ok) {
        setSaving(null);
        return refused(result.error.code, "record");
      }
      setNote(result.data);
      setDraft(draftOf(result.data, fields));
      setMode("view");
      setReason("");
      setCopied(null);
    }
    setSaving(null);
    setDone("success");
    window.setTimeout(() => setDone("idle"), 1600);
  }

  async function toggleTag(tagId: string, attached: boolean) {
    if (tagBusy) return;
    setTagBusy(tagId);
    const result = await actions.setTag({
      requestId: idFor(`tag:${tagId}:${attached}:${prep.clientTagIds.join()}`),
      clientId: prep.clientId,
      tagId,
      attached,
    });
    setTagBusy(null);
    if (result.ok)
      setPrep((current) => ({ ...current, clientTagIds: result.data.tagIds }));
    else
      setFailure({
        title: "Étiquette non modifiée",
        message: "Les étiquettes affichées sont celles enregistrées. Réessaie.",
        tone: result.error.code === "network" ? "offline" : "error",
      });
  }

  const editing = mode !== "view";
  const last = prep.lastRecord;

  return (
    <div className="flex flex-col gap-5">
      <Section title="Préparer la visite" eyebrow={prep.clientName}>
        <p className="text-[14px] text-ink-soft first-letter:uppercase">
          {prep.serviceName} · {day(prep.startsAt)}
        </p>
        {prep.preferences.text ? (
          <p className="rounded-2xl bg-sand/60 px-4 py-3 text-[14.5px] leading-relaxed whitespace-pre-line text-ink">
            {prep.preferences.text}
          </p>
        ) : (
          <p className="text-[14px] text-ink-muted">
            Aucune préférence notée pour cette cliente.
          </p>
        )}

        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-semibold text-ink">Étiquettes</p>
          <ul className="flex flex-wrap gap-2" aria-label="Étiquettes">
            {prep.tags
              .filter(
                (tag) => !tag.archived || prep.clientTagIds.includes(tag.id),
              )
              .map((tag) => {
                const on = prep.clientTagIds.includes(tag.id);
                return (
                  <li key={tag.id}>
                    {tag.archived ? (
                      // Kept on her history; no longer offered.
                      <span className="flex h-9 items-center rounded-full border border-dashed border-line px-3 text-[13.5px] text-ink-muted">
                        {tag.label} · archivée
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-pressed={on}
                        disabled={tagBusy !== null}
                        onClick={() => void toggleTag(tag.id, !on)}
                        className={cn(
                          "h-9 cursor-pointer rounded-full border px-3 text-[13.5px] font-medium transition-colors disabled:cursor-wait",
                          on
                            ? "border-ink bg-ink text-paper-raised"
                            : "border-line bg-paper text-ink-soft hover:border-line-strong",
                          tagBusy === tag.id && "opacity-60",
                        )}
                      >
                        {tag.label}
                      </button>
                    )}
                  </li>
                );
              })}
          </ul>
        </div>

        {last ? (
          <div className="flex flex-col gap-2 rounded-2xl border border-line bg-paper px-4 py-3">
            <p className="text-[13px] font-semibold text-ink">
              Dernière fiche · {day(last.visitStartsAt)} · {last.serviceName}
            </p>
            <Values note={last} />
            {editing ? (
              <button
                type="button"
                disabled={busy}
                className={cn(linkAction, "w-fit")}
                onClick={() => {
                  const taken = copyFrom(last, fields);
                  setDraft(taken.draft);
                  setCopied({
                    from: last.visitStartsAt,
                    removed: taken.removed,
                  });
                  setErrors({});
                }}
              >
                Reprendre ces valeurs
              </button>
            ) : null}
          </div>
        ) : null}
      </Section>

      <Section
        title="Fiche de cette visite"
        eyebrow={
          mode === "correct"
            ? "Correction"
            : recorded
              ? "Validée"
              : savedDraft
                ? "Brouillon"
                : "À remplir"
        }
      >
        {failure ? (
          <Notice tone={failure.tone} title={failure.title}>
            {failure.message}
          </Notice>
        ) : null}

        {conflict && conflict.length > 0 ? (
          <div
            role="group"
            aria-label="Différences avec la fiche enregistrée"
            className="flex flex-col gap-2 rounded-2xl border border-line bg-paper px-4 py-3"
          >
            <p className="text-[13.5px] font-semibold text-ink">
              Cette fiche a changé ailleurs. Ta saisie est gardée.
            </p>
            <ul className="flex flex-col gap-2">
              {conflict.map((item) => (
                <li
                  key={item.fieldId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] text-ink-soft"
                >
                  <span className="font-medium text-ink">{item.label}</span>
                  <span>
                    toi : {item.mine || "vide"} · enregistré :{" "}
                    {item.theirs || "vide"}
                  </span>
                  <button
                    type="button"
                    className={linkAction}
                    onClick={() => {
                      setValue(item.fieldId, item.theirs);
                      setConflict(
                        (current) =>
                          current?.filter(
                            (other) => other.fieldId !== item.fieldId,
                          ) ?? null,
                      );
                    }}
                  >
                    Prendre l’enregistré
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={cn(linkAction, "w-fit")}
              onClick={() => setConflict(null)}
            >
              Garder ma saisie
            </button>
          </div>
        ) : null}

        {copied ? (
          <p role="status" className="text-[13.5px] text-ink-soft">
            Valeurs reprises de la visite du {day(copied.from)}.
            {copied.removed.length
              ? ` Non repris, ces champs n’existent plus : ${copied.removed.join(", ")}.`
              : ""}
          </p>
        ) : null}

        {editing ? (
          <>
            {mode === "correct" && recorded ? (
              <div className="flex flex-col gap-1.5">
                <label className="flex flex-col gap-1.5 text-[13.5px] font-medium text-ink">
                  Ce qui est corrigé
                  <input
                    value={reason}
                    maxLength={200}
                    readOnly={busy}
                    aria-invalid={Boolean(errors.reason) || undefined}
                    onChange={(event) => {
                      setReason(event.target.value);
                      setErrors((current) => without(current, "reason"));
                    }}
                    placeholder="Longueur notée par erreur…"
                    className={cn(inputClass, errors.reason && "border-danger")}
                  />
                </label>
                {errors.reason ? (
                  <p role="alert" className="text-[13px] text-danger">
                    {errors.reason}
                  </p>
                ) : (
                  <p className="text-[13px] text-ink-muted">
                    La fiche validée le {day(recorded.recordedAt!)} reste dans
                    l’historique, marquée comme remplacée.
                  </p>
                )}
              </div>
            ) : null}

            {fields.length === 0 ? (
              <p className="text-[14px] text-ink-muted">
                Aucun champ n’est défini pour cette prestation.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {fields.map((field) => (
                  <FieldInput
                    key={field.id}
                    field={field}
                    value={draft.values[field.id] ?? ""}
                    error={errors[field.id]}
                    readOnly={busy}
                    onChange={(value) => setValue(field.id, value)}
                  />
                ))}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <p className="text-[13.5px] font-medium text-ink">
                Produits utilisés
              </p>
              {draft.products.map((product, index) => (
                <div key={index} className="flex flex-col gap-1">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.5rem] gap-2 sm:grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_2.5rem]">
                    {(
                      [
                        ["name", "Nom", "col-span-3 sm:col-span-1"],
                        ["quantity", "Quantité", ""],
                        ["unit", "Unité", ""],
                      ] as const
                    ).map(([key, label, span]) => (
                      <input
                        key={key}
                        aria-label={`${label} du produit ${index + 1}`}
                        placeholder={label}
                        value={product[key]}
                        readOnly={busy}
                        maxLength={key === "name" ? 80 : 20}
                        onChange={(event) => {
                          const value = event.target.value;
                          setDraft((current) => ({
                            ...current,
                            products: current.products.map((item, at) =>
                              at === index ? { ...item, [key]: value } : item,
                            ),
                          }));
                          setErrors((current) =>
                            without(current, `product:${index}`),
                          );
                        }}
                        className={cn(inputClass, span)}
                      />
                    ))}
                    <button
                      type="button"
                      aria-label={`Retirer le produit ${index + 1}`}
                      disabled={busy}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          products: current.products.filter(
                            (_, at) => at !== index,
                          ),
                        }))
                      }
                      className="flex size-10 cursor-pointer items-center justify-center rounded-xl text-ink-soft hover:bg-sand hover:text-ink disabled:opacity-40"
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </div>
                  {errors[`product:${index}`] ? (
                    <p role="alert" className="text-[13px] text-danger">
                      {errors[`product:${index}`]}
                    </p>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                disabled={busy}
                className={cn(linkAction, "w-fit")}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    products: [...current.products, emptyProduct()],
                  }))
                }
              >
                Ajouter un produit
              </button>
              <p className="text-[13px] text-ink-muted">
                Noté pour mémoire : aucun stock n’est modifié.
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                size="md"
                disabled={
                  isEmpty(draft, fields) || (busy && saving !== "record")
                }
                state={saving === "record" ? "loading" : "idle"}
                loadingLabel="Validation…"
                onClick={() => void save(true)}
              >
                {mode === "correct"
                  ? "Valider la correction"
                  : "Valider la fiche"}
              </Button>
              <Button
                variant="secondary"
                size="md"
                disabled={!dirty || (busy && saving !== "draft")}
                state={saving === "draft" ? "loading" : done}
                loadingLabel="Enregistrement…"
                successLabel="Brouillon enregistré"
                onClick={() => void save(false)}
              >
                Enregistrer le brouillon
              </Button>
              {mode === "correct" && recorded ? (
                <Button
                  variant="ghost"
                  size="md"
                  disabled={busy}
                  onClick={() => {
                    setMode("view");
                    setDraft(draftOf(recorded, fields));
                    setErrors({});
                    setFailure(null);
                    setConflict(null);
                  }}
                >
                  Annuler la correction
                </Button>
              ) : null}
            </div>
            <p className="text-[13px] text-ink-muted">
              {dirty
                ? "Des changements ne sont pas enregistrés."
                : savedDraft
                  ? "Brouillon enregistré. Validée, la fiche ne se modifie plus : elle se corrige."
                  : "Validée, la fiche ne se modifie plus : elle se corrige."}
            </p>
          </>
        ) : recorded ? (
          <>
            <Values note={recorded} />
            <p className="text-[13px] text-ink-muted">
              Validée le {day(recorded.recordedAt!)}.
              {recorded.correctionReason
                ? ` Correction : ${recorded.correctionReason}`
                : ""}
            </p>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setMode("correct");
                setDraft(draftOf(recorded, fields));
                setFailure(null);
              }}
            >
              Corriger cette fiche
            </Button>
          </>
        ) : null}
      </Section>
    </div>
  );
}

/** The errors without one field's (it was just edited). */
const without = (errors: Record<string, string>, key: string) =>
  Object.fromEntries(Object.entries(errors).filter(([field]) => field !== key));

const inputClass =
  "h-11 w-full min-w-0 rounded-xl border border-line bg-paper-raised px-3 text-[15px] font-normal text-ink outline-none placeholder:text-ink-muted focus-visible:border-ink";

function Section({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-4 rounded-3xl border border-line bg-paper-raised px-5 py-5"
    >
      <div className="flex flex-col gap-0.5">
        <p className="text-[12.5px] font-semibold tracking-[0.14em] text-ink-muted uppercase">
          {eyebrow}
        </p>
        <h2 className="font-display text-[24px] leading-tight text-ink">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

/** A sheet read back: its values as they were written, then its products. */
function Values({ note }: { note: TechnicalNoteDto }) {
  if (note.fieldValues.length === 0 && note.products.length === 0)
    return <p className="text-[14px] text-ink-muted">Fiche vide.</p>;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[14px] sm:grid-cols-3">
      {note.fieldValues.map((value) => (
        <div key={value.fieldId} className="flex min-w-0 flex-col">
          <dt className="text-[12.5px] text-ink-muted">{value.label}</dt>
          <dd className="wrap-anywhere text-ink">
            {value.value}
            {value.unit ? ` ${value.unit}` : ""}
          </dd>
        </div>
      ))}
      {note.products.map((product, index) => (
        <div key={`p${index}`} className="flex min-w-0 flex-col">
          <dt className="text-[12.5px] text-ink-muted">Produit</dt>
          <dd className="wrap-anywhere text-ink">
            {product.name}
            {product.quantity ? ` · ${product.quantity} ${product.unit}` : ""}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FieldInput({
  field,
  value,
  error,
  readOnly,
  onChange,
}: {
  field: FieldDefinitionDto;
  value: string;
  error?: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  const label = field.unit ? `${field.label} (${field.unit})` : field.label;
  if (field.kind === "choice")
    return (
      <div role="group" aria-label={label} className="flex flex-col gap-1.5">
        <p className="text-[13.5px] font-medium text-ink">{label}</p>
        <div className="flex flex-wrap gap-2">
          {field.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={value === choice}
              disabled={readOnly}
              // Pressed again: no answer.
              onClick={() => onChange(value === choice ? "" : choice)}
              className={cn(
                "h-10 min-w-11 cursor-pointer rounded-xl border px-3 text-[14.5px] font-medium transition-colors",
                value === choice
                  ? "border-ink bg-ink text-paper-raised"
                  : "border-line bg-paper text-ink hover:border-line-strong",
              )}
            >
              {choice}
            </button>
          ))}
        </div>
        {error ? (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1.5 text-[13.5px] font-medium text-ink">
        {label}
        <input
          value={value}
          readOnly={readOnly}
          inputMode={field.kind === "number" ? "decimal" : undefined}
          aria-invalid={Boolean(error) || undefined}
          onChange={(event) => onChange(event.target.value)}
          className={cn(inputClass, error && "border-danger")}
        />
      </label>
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

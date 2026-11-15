"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";

import { ClientForm, dayLabel } from "../client-form";
import type {
  ClientFormActions,
  FormFieldDto,
  FormFieldType,
} from "../contract";
import {
  editorErrors,
  type EditorResult,
  type FormDraft,
  type FormEditorActions,
  type FormTemplateDto,
} from "./contract";
import {
  dependentsOf,
  draftProblems,
  move,
  newField,
  newOption,
  sameDraft,
  typeLabels,
} from "./draft";

// Her form template: one draft she edits, versions nobody edits. Saving
// keeps the draft; publishing freezes it as the next version (forms
// already sent keep theirs). Questions move with buttons, so the keyboard
// does everything a mouse does; a condition always points to an earlier
// question, and a move that breaks one says so under the question.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50";

type Read =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; template: FormTemplateDto };

export function FormEditor({
  templateId,
  businessName,
  actions,
}: {
  templateId: string;
  businessName: string;
  actions: FormEditorActions;
}) {
  const [read, setRead] = useState<Read>({ status: "loading" });
  const [run, setRun] = useState(0);
  const [draft, setDraft] = useState<FormDraft | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [notice, setNotice] = useState<{
    tone: "error" | "success";
    text: string;
  } | null>(null);
  const [conflict, setConflict] = useState<FormTemplateDto | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  const [announce, setAnnounce] = useState("");
  const requestIds = useRef(new Map<string, string>());
  const idFor = (key: string) => {
    if (!requestIds.current.has(key))
      requestIds.current.set(key, crypto.randomUUID());
    return requestIds.current.get(key)!;
  };

  useEffect(() => {
    let current = true;
    void actions.read(templateId).then((result) => {
      if (!current) return;
      if (!result.ok) return setRead({ status: "error" });
      setRead({ status: "ready", template: result.data });
      setDraft((mine) => mine ?? structuredClone(result.data.draft));
    });
    return () => {
      current = false;
    };
  }, [actions, templateId, run]);

  const template = read.status === "ready" ? read.template : null;
  const dirty = Boolean(template && draft && !sameDraft(draft, template.draft));

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const problems = useMemo(() => (draft ? draftProblems(draft) : {}), [draft]);

  // The preview is the client's own view, on this draft, never sending.
  const previewActions = useMemo<ClientFormActions | null>(
    () =>
      draft
        ? {
            read: async () => ({
              ok: true,
              data: {
                assignmentId: "apercu",
                templateVersionId: "brouillon",
                title: draft.title || "Sans titre",
                businessName,
                intro: draft.intro || null,
                status: "assigned",
                expiresAt: null,
                canSubmit: true,
                review: draft.review,
                fields: draft.fields,
                receipt: null,
              },
            }),
            submit: async () => ({ ok: false, error: { code: "preview" } }),
          }
        : null,
    [draft, businessName],
  );

  if (read.status === "loading" || !draft)
    return read.status === "error" ? (
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
        Rien n’a été modifié.
      </Notice>
    ) : (
      <div role="status" aria-label="Chargement du formulaire…">
        <div className="h-64 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );

  const server = template!;
  const latest = server.published[0] ?? null;
  const nextNumber = (latest?.number ?? 0) + 1;

  function change(next: FormDraft) {
    setDraft(next);
    setNotice(null);
    setConfirmPublish(false);
  }
  const setField = (id: string, patch: Partial<FormFieldDto>) =>
    change({
      ...draft!,
      fields: draft!.fields.map((field) =>
        field.id === id ? { ...field, ...patch } : field,
      ),
    });

  function focusLater(selector: string) {
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(selector)?.focus(),
    );
  }

  function moveField(index: number, delta: -1 | 1) {
    const field = draft!.fields[index]!;
    const fields = move(draft!.fields, index, delta);
    change({ ...draft!, fields });
    const at = fields.indexOf(field);
    setAnnounce(
      `« ${field.label || typeLabels[field.type]} » est maintenant la question ${at + 1} sur ${fields.length}.`,
    );
    // Focus stays on the arrow just used; at an end, on the other one.
    const first = at === 0;
    const last = at === fields.length - 1;
    const which = delta < 0 ? (first ? "down" : "up") : last ? "up" : "down";
    focusLater(`[data-question="${field.id}"] [data-move="${which}"]`);
  }

  function removeField(field: FormFieldDto) {
    const dependents = dependentsOf(draft!.fields, field.id);
    if (dependents.length) {
      setBlocked({
        [field.id]: `${dependents
          .map((item) => `« ${item.label || typeLabels[item.type]} »`)
          .join(
            ", ",
          )} ${dependents.length > 1 ? "dépendent" : "dépend"} de cette question : change d’abord sa condition.`,
      });
      return;
    }
    setBlocked({});
    const index = draft!.fields.indexOf(field);
    const fields = draft!.fields.filter((item) => item.id !== field.id);
    change({ ...draft!, fields });
    setAnnounce("Question retirée.");
    const neighbour = fields[Math.min(index, fields.length - 1)];
    focusLater(
      neighbour
        ? `[data-question="${neighbour.id}"] input`
        : "[data-add-question] button",
    );
  }

  function addField(type: FormFieldType) {
    const field = newField(type);
    change({ ...draft!, fields: [...draft!.fields, field] });
    focusLater(`[data-question="${field.id}"] input`);
  }

  function failed(result: EditorResult<unknown>, what: string) {
    if (result.ok) return;
    if (result.error.code === editorErrors.versionConflict) {
      void actions.read(templateId).then((fresh) => {
        if (fresh.ok) setConflict(fresh.data);
      });
      return setNotice({
        tone: "error",
        text: "Ce formulaire a été enregistré ailleurs entre-temps. Ta version est gardée ici : choisis laquelle garder.",
      });
    }
    setNotice({
      tone: "error",
      text:
        result.error.code === "network"
          ? `Pas de réponse. Réessaie : la même demande ne s’applique jamais deux fois.`
          : result.error.code === editorErrors.invalidTemplate
            ? "Le formulaire a encore des points à corriger."
            : `${what} n’a pas abouti. Réessaie dans un instant.`,
    });
  }

  async function save(base = server) {
    if (busy) return;
    setBusy("save");
    setNotice(null);
    const result = await actions.saveDraft({
      templateId,
      expectedDraftVersion: base.draftVersion,
      requestId: idFor(`save:${base.draftVersion}:${JSON.stringify(draft)}`),
      draft: draft!,
    });
    setBusy(null);
    if (!result.ok) return failed(result, "L’enregistrement");
    setConflict(null);
    setRead({ status: "ready", template: result.data });
    setNotice({ tone: "success", text: "Brouillon enregistré." });
  }

  async function publish() {
    if (busy) return;
    setBusy("publish");
    setNotice(null);
    const result = await actions.publish({
      templateId,
      expectedDraftVersion: server.draftVersion,
      requestId: idFor(`publish:${server.draftVersion}`),
    });
    setBusy(null);
    setConfirmPublish(false);
    if (!result.ok) return failed(result, "La publication");
    setRead({ status: "ready", template: result.data });
    setNotice({
      tone: "success",
      text: `Version ${result.data.published[0]?.number} publiée. Les formulaires déjà envoyés gardent la leur.`,
    });
  }

  function askPublish() {
    setShowErrors(true);
    const first = Object.keys(problems)[0];
    if (first) {
      setNotice({
        tone: "error",
        text: "Corrige les points signalés avant de publier.",
      });
      return focusLater(
        first.startsWith("_")
          ? `[data-problem="${first}"] input, [data-problem="${first}"]`
          : `[data-question="${first}"] input`,
      );
    }
    setConfirmPublish(true);
  }

  const shownProblems = showErrors ? problems : {};

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-[13px] font-medium tracking-[0.08em] text-ink-muted uppercase">
          Formulaire
        </p>
        <h1 className="font-display text-[32px] leading-tight text-ink">
          {draft.title || "Sans titre"}
        </h1>
        <p className="text-[14px] text-ink-soft">
          {latest
            ? `Version ${latest.number} publiée le ${dayLabel(latest.publishedAt)}.`
            : "Jamais publié : tes clientes ne le reçoivent pas encore."}
          {dirty ? " Modifications non enregistrées." : ""}
        </p>
      </header>

      <div
        role="group"
        aria-label="Affichage"
        className="flex w-fit rounded-full bg-sand p-1"
      >
        {(
          [
            ["edit", "Modifier"],
            ["preview", "Aperçu cliente"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
            className={cn(
              "h-9 cursor-pointer rounded-full px-4 text-[13.5px] font-medium",
              mode === value
                ? "bg-paper-raised text-ink shadow-sm"
                : "text-ink-soft",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <p aria-live="polite" className="sr-only">
        {announce}
      </p>

      {notice ? (
        <Notice
          tone={notice.tone}
          title={notice.tone === "error" ? "À revoir" : "C’est fait"}
        >
          {notice.text}
        </Notice>
      ) : null}

      {conflict ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="md"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void save(conflict)}
          >
            Garder ma version
          </Button>
          <Button
            size="md"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => {
              setRead({ status: "ready", template: conflict });
              setDraft(structuredClone(conflict.draft));
              setConflict(null);
              setNotice(null);
            }}
          >
            Prendre la version enregistrée
          </Button>
        </div>
      ) : null}

      {mode === "preview" && previewActions ? (
        <div className="rounded-3xl border border-line bg-paper px-4 py-6 sm:px-6">
          <ClientForm
            key={JSON.stringify(draft)}
            assignmentId="apercu"
            actions={previewActions}
            preview
          />
        </div>
      ) : (
        <>
          <section
            aria-label="Réglages du formulaire"
            className="flex flex-col gap-4 rounded-3xl border border-line bg-paper-raised px-5 py-5"
          >
            <div data-problem="_title">
              <TextField
                label="Titre vu par tes clientes"
                name="form-title"
                autoComplete="off"
                value={draft.title}
                error={shownProblems._title}
                onChange={(event) =>
                  change({ ...draft, title: event.target.value })
                }
              />
            </div>
            <TextAreaField
              label="Introduction"
              optional
              name="form-intro"
              rows={2}
              value={draft.intro}
              onChange={(event) =>
                change({ ...draft, intro: event.target.value })
              }
            />
            <label className="flex items-center justify-between gap-4">
              <span className="flex flex-col">
                <span className="text-[15px] font-medium text-ink">
                  Relire les réponses
                </span>
                <span className="text-[13px] text-ink-muted">
                  Elles comptent une fois que tu les as relues.
                </span>
              </span>
              <Switch
                checked={draft.review === "professional"}
                onChange={() =>
                  change({
                    ...draft,
                    review:
                      draft.review === "professional" ? "none" : "professional",
                  })
                }
                aria-label="Relire les réponses"
              />
            </label>
            <fieldset className="flex flex-col gap-2" data-problem="_frequency">
              <legend className="mb-1 text-[15px] font-medium text-ink">
                À demander
              </legend>
              <label className="flex cursor-pointer items-center gap-3 text-[14.5px] text-ink">
                <input
                  type="radio"
                  name="frequency"
                  checked={draft.frequency.kind === "every_appointment"}
                  onChange={() =>
                    change({
                      ...draft,
                      frequency: { kind: "every_appointment" },
                    })
                  }
                  className="size-4 accent-[var(--ink)]"
                />
                À chaque rendez-vous
              </label>
              <label className="flex cursor-pointer items-center gap-3 text-[14.5px] text-ink">
                <input
                  type="radio"
                  name="frequency"
                  checked={draft.frequency.kind === "reuse_completed_for_days"}
                  onChange={() =>
                    change({
                      ...draft,
                      frequency: {
                        kind: "reuse_completed_for_days",
                        days: 90,
                      },
                    })
                  }
                  className="size-4 accent-[var(--ink)]"
                />
                Une fois, puis valable un certain temps
              </label>
              {draft.frequency.kind === "reuse_completed_for_days" ? (
                <div className="max-w-48 pl-7">
                  <TextField
                    label="Valable (jours)"
                    name="frequency-days"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={365}
                    value={String(draft.frequency.days || "")}
                    error={shownProblems._frequency}
                    onChange={(event) =>
                      change({
                        ...draft,
                        frequency: {
                          kind: "reuse_completed_for_days",
                          days: Number(event.target.value),
                        },
                      })
                    }
                  />
                </div>
              ) : null}
            </fieldset>
          </section>

          <section aria-label="Questions" className="flex flex-col gap-3">
            <h2 className="text-[17px] font-semibold text-ink">Questions</h2>
            {shownProblems._form ? (
              <p className="text-[14px] font-medium text-danger">
                {shownProblems._form}
              </p>
            ) : null}
            <ol className="flex flex-col gap-3">
              {draft.fields.map((field, index) => (
                <QuestionCard
                  key={field.id}
                  field={field}
                  index={index}
                  count={draft.fields.length}
                  earlier={draft.fields.slice(0, index)}
                  problem={blocked[field.id] ?? shownProblems[field.id]}
                  onChange={(patch) => setField(field.id, patch)}
                  onMove={(delta) => moveField(index, delta)}
                  onRemove={() => removeField(field)}
                />
              ))}
            </ol>
            <div
              data-add-question
              className="flex flex-wrap items-center gap-2 rounded-3xl border border-dashed border-line-strong px-4 py-3"
            >
              <span className="text-[14px] text-ink-soft">Ajouter :</span>
              {(Object.keys(typeLabels) as FormFieldType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => addField(type)}
                  className="h-9 cursor-pointer rounded-full border border-line bg-paper-raised px-3.5 text-[13.5px] font-medium text-ink hover:border-line-strong"
                >
                  {typeLabels[type]}
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      <div className="sticky bottom-0 -mx-4 flex flex-col gap-3 border-t border-line bg-paper/95 px-4 py-4 backdrop-blur sm:mx-0 sm:rounded-3xl sm:border">
        {confirmPublish ? (
          <div className="flex flex-col gap-3">
            <p className="text-[14.5px] text-ink">
              Publier la version {nextNumber} ? Elle ne pourra plus être
              modifiée ; les formulaires déjà envoyés gardent leur version.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="md"
                state={busy === "publish" ? "loading" : "idle"}
                loadingLabel="Publication…"
                onClick={() => void publish()}
              >
                Publier la version {nextNumber}
              </Button>
              <Button
                size="md"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setConfirmPublish(false)}
              >
                Annuler
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="md"
              variant="secondary"
              state={busy === "save" ? "loading" : "idle"}
              loadingLabel="Enregistrement…"
              disabled={!dirty || (busy !== null && busy !== "save")}
              onClick={() => void save()}
            >
              Enregistrer le brouillon
            </Button>
            <Button
              size="md"
              disabled={dirty || busy !== null}
              onClick={askPublish}
            >
              Publier…
            </Button>
            {dirty ? (
              <span className="text-[13px] text-ink-muted">
                Enregistre avant de publier.
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function QuestionCard({
  field,
  index,
  count,
  earlier,
  problem,
  onChange,
  onMove,
  onRemove,
}: {
  field: FormFieldDto;
  index: number;
  count: number;
  earlier: FormFieldDto[];
  problem: string | undefined;
  onChange: (patch: Partial<FormFieldDto>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const number = index + 1;
  const sources = earlier.filter(
    (item) => item.type === "boolean" || item.type === "single_choice",
  );
  const source = field.showIf
    ? earlier.find((item) => item.id === field.showIf!.field)
    : undefined;
  const problemId = `problem-${field.id}`;
  return (
    <li
      data-question={field.id}
      aria-describedby={problem ? problemId : undefined}
      className={cn(
        "flex flex-col gap-4 rounded-3xl border bg-paper-raised px-5 py-4",
        problem ? "border-danger" : "border-line",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-ink-muted">
          Question {number} · {typeLabels[field.type]}
        </p>
        <div className="flex items-center gap-1">
          <IconButton
            data-move="up"
            label={`Monter la question ${number}`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </IconButton>
          <IconButton
            data-move="down"
            label={`Descendre la question ${number}`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </IconButton>
          <button
            type="button"
            className={cn(linkAction, "ml-2 text-[13px] text-danger")}
            onClick={onRemove}
            aria-label={`Retirer la question ${number}`}
          >
            Retirer
          </button>
        </div>
      </div>

      {problem ? (
        <p id={problemId} className="text-[13.5px] font-medium text-danger">
          {problem}
        </p>
      ) : null}

      <TextField
        label={field.type === "attestation" ? "Titre" : "Question"}
        name={`label-${field.id}`}
        autoComplete="off"
        value={field.label}
        onChange={(event) => onChange({ label: event.target.value })}
      />

      {field.type === "attestation" ? (
        <TextAreaField
          label="Texte à confirmer"
          name={`attestation-${field.id}`}
          rows={3}
          hint="Le texte exact que ta cliente confirme est gardé avec sa réponse."
          value={field.attestationText ?? ""}
          onChange={(event) =>
            onChange({ attestationText: event.target.value })
          }
        />
      ) : (
        <TextField
          label="Aide"
          optional
          name={`help-${field.id}`}
          autoComplete="off"
          value={field.help ?? ""}
          onChange={(event) => onChange({ help: event.target.value || null })}
        />
      )}

      {field.type === "single_choice" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[14px] font-medium text-ink">
            Choix
          </legend>
          {(field.options ?? []).map((option, at) => (
            <div key={option.id} className="flex items-center gap-2">
              <input
                aria-label={`Choix ${at + 1}`}
                value={option.label}
                autoComplete="off"
                onChange={(event) =>
                  onChange({
                    options: field.options!.map((item) =>
                      item.id === option.id
                        ? { ...item, label: event.target.value }
                        : item,
                    ),
                  })
                }
                className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-paper px-3 text-[15px] text-ink outline-none focus-visible:border-ink"
              />
              <IconButton
                label={`Retirer le choix ${at + 1}`}
                disabled={field.options!.length <= 1}
                onClick={() =>
                  onChange({
                    options: field.options!.filter(
                      (item) => item.id !== option.id,
                    ),
                  })
                }
              >
                ×
              </IconButton>
            </div>
          ))}
          <button
            type="button"
            className={cn(linkAction, "w-fit text-[13.5px]")}
            onClick={() =>
              onChange({ options: [...(field.options ?? []), newOption()] })
            }
          >
            Ajouter un choix
          </button>
        </fieldset>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="sm:flex-1">
          <SelectField
            label="Afficher"
            value={field.showIf?.field ?? ""}
            onChange={(event) => {
              const target = earlier.find(
                (item) => item.id === event.target.value,
              );
              onChange({
                showIf: target
                  ? {
                      field: target.id,
                      equals:
                        target.type === "boolean"
                          ? true
                          : (target.options?.[0]?.id ?? ""),
                    }
                  : null,
              });
            }}
          >
            <option value="">Toujours</option>
            {sources.map((item) => (
              <option key={item.id} value={item.id}>
                Selon « {item.label || typeLabels[item.type]} »
              </option>
            ))}
            {field.showIf && !source ? (
              <option value={field.showIf.field}>
                Selon une question placée après (à corriger)
              </option>
            ) : null}
          </SelectField>
        </div>
        {field.showIf && source ? (
          <div className="sm:flex-1">
            <SelectField
              label="Si la réponse est"
              value={String(field.showIf.equals)}
              onChange={(event) =>
                onChange({
                  showIf: {
                    field: source.id,
                    equals:
                      source.type === "boolean"
                        ? event.target.value === "true"
                        : event.target.value,
                  },
                })
              }
            >
              {source.type === "boolean" ? (
                <>
                  <option value="true">Oui</option>
                  <option value="false">Non</option>
                </>
              ) : (
                (source.options ?? []).map((option, at) => (
                  <option key={option.id} value={option.id}>
                    {option.label || `Choix ${at + 1}`}
                  </option>
                ))
              )}
            </SelectField>
          </div>
        ) : null}
      </div>

      <label className="flex items-center justify-between gap-4">
        <span className="text-[14.5px] text-ink">Réponse obligatoire</span>
        <Switch
          checked={field.required}
          onChange={() => onChange({ required: !field.required })}
          aria-label={`Réponse obligatoire, question ${number}`}
        />
      </label>
    </li>
  );
}

function IconButton({
  label,
  children,
  ...props
}: {
  label: string;
  children: string;
  disabled?: boolean;
  onClick: () => void;
  "data-move"?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex size-9 cursor-pointer items-center justify-center rounded-full text-[17px] text-ink-soft hover:bg-sand hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
      {...props}
    >
      <span aria-hidden>{children}</span>
    </button>
  );
}

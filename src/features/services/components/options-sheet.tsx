"use client";

import { useEffect, useState } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import {
  callAction,
  type UiError,
  type UiResult,
} from "@/features/auth/client/call-action";
import { setServiceOptionsAction } from "@/features/catalog/actions/catalog";
import {
  checkOptions,
  commandOf,
  draftOf,
  emptyChoice,
  emptyOption,
  moved,
  optionsChanged,
  type ChoiceDraft,
  type OptionDraft,
  type OptionErrors,
} from "@/features/catalog/client/options-draft";
import type { CatalogServiceDto } from "@/features/catalog/data/catalog";
import { catalogLimits, type ServiceOption } from "@/features/catalog/model";
import { cn } from "@/lib/cn";

import type { SetServiceOptionsInput } from "@/features/catalog/schemas";

import type { ServiceView } from "../client/service-form";

/** Saves a service's options; the server's action unless a preview gives its own. */
export type SaveOptions = (
  command: SetServiceOptionsInput,
) => Promise<UiResult<CatalogServiceDto>>;

const saveOnServer: SaveOptions = (command) =>
  callAction(() => setServiceOptionsAction(command));

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The options of one service (docs/CATALOG_CONTRACT.md): the questions her
 * client answers when booking, and what each answer adds. Nothing is
 * specific to a trade: a length, a size, an area, a finish.
 *
 * - Saved as a whole, at once (the catalogue has no draft), on the version
 *   the service was read at. Changed elsewhere (`stale_service`,
 *   `options_incomplete`): nothing is written; she takes the current
 *   options back, knowing hers here are dropped.
 * - What she removed is named to the server: nothing is deleted by
 *   omission.
 * - The price and duration her clients are quoted are the server's.
 */
export function OptionsSheet({
  service,
  saved,
  onClose,
  onSaved,
  onReload,
  save = saveOnServer,
}: {
  /** The service whose options are open; null: closed. */
  service: ServiceView | null;
  saved: ServiceOption[];
  onClose: () => void;
  onSaved: (service: CatalogServiceDto) => void;
  /** Reads her catalogue again (changed or deleted elsewhere). */
  onReload: () => void;
  /** Her server; an in-memory one only in a design preview. */
  save?: SaveOptions;
}) {
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** She asked to close with changes not saved: asked first. */
  const [leaving, setLeaving] = useState(false);
  const close = () => {
    setLeaving(false);
    setDirty(false);
    onClose();
  };
  return (
    <Sheet
      open={service !== null}
      // Every way out (the cross, Escape, the backdrop) asks the same.
      onClose={() => {
        if (busy) return;
        if (dirty) setLeaving(true);
        else close();
      }}
      title={service ? `Options · ${service.name}` : "Options"}
      description="Les questions posées à ta cliente quand elle réserve, et ce que chaque réponse ajoute au prix et à la durée."
    >
      {service ? (
        <Editor
          // Another service, or the same one read again: a fresh draft.
          key={`${service.id}:${service.version}`}
          service={service}
          saved={saved}
          onBusy={setBusy}
          onDirty={setDirty}
          leaving={leaving}
          onStay={() => setLeaving(false)}
          onClose={close}
          onSaved={onSaved}
          onReload={onReload}
          save={save}
        />
      ) : null}
    </Sheet>
  );
}

function Editor({
  service,
  saved,
  onBusy,
  onDirty,
  leaving,
  onStay,
  onClose,
  onSaved,
  onReload,
  save: send,
}: {
  service: ServiceView;
  saved: ServiceOption[];
  save: SaveOptions;
  onBusy: (busy: boolean) => void;
  /** Whether her draft differs from what is saved. */
  onDirty: (dirty: boolean) => void;
  leaving: boolean;
  onStay: () => void;
  onClose: () => void;
  onSaved: (service: CatalogServiceDto) => void;
  onReload: () => void;
}) {
  const [draft, setDraft] = useState<OptionDraft[]>(() => draftOf(saved));
  const [errors, setErrors] = useState<OptionErrors>({});
  const [state, setState] = useState<ButtonState>("idle");
  const [failure, setFailure] = useState<UiError | null>(null);
  const saving = state !== "idle";
  const changed = optionsChanged(saved, draft);
  useEffect(() => onDirty(changed), [changed, onDirty]);
  const stale =
    failure?.code === "stale_service" || failure?.code === "options_incomplete";
  const gone =
    failure?.code === "not_found" || failure?.code === "service_deleted";

  const update = (next: OptionDraft[]) => {
    setDraft(next);
    setFailure(null);
  };
  const setOption = (key: string, patch: Partial<OptionDraft>) =>
    update(
      draft.map((option) =>
        option.key === key ? { ...option, ...patch } : option,
      ),
    );
  const setChoice = (
    option: OptionDraft,
    key: string,
    patch: Partial<ChoiceDraft>,
  ) =>
    setOption(option.key, {
      choices: option.choices.map((choice) =>
        choice.key === key ? { ...choice, ...patch } : choice,
      ),
    });
  const clear = (key: string) => {
    if (!errors[key]) return;
    setErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([field]) => field !== key),
      ),
    );
  };

  async function save() {
    if (saving) return;
    const found = checkOptions(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setFailure(null);
    setState("loading");
    onBusy(true);
    const result = await send(
      commandOf(service.id, service.version, saved, draft),
    );
    onBusy(false);
    if (!result.ok) {
      setState("idle");
      setFailure(result.error);
      return;
    }
    setState("success");
    onSaved(result.data);
  }

  const invalid = Object.keys(errors).length;

  return (
    <div className="flex flex-col gap-5">
      {draft.length === 0 ? (
        <div className="flex flex-col gap-2 rounded-2xl bg-sand/60 px-4 py-4 text-[14px] leading-relaxed text-ink-soft">
          <p className="font-semibold text-ink">
            Cette prestation n’a pas d’option.
          </p>
          <p>
            Une option est une question avec ses réponses : une longueur, la
            taille d’un motif, une zone, une finition. Chaque réponse peut
            ajouter un prix et du temps ; ta cliente voit le total avant de
            choisir son créneau.
          </p>
        </div>
      ) : (
        <ol className="flex flex-col gap-4">
          {draft.map((option, index) => (
            <li
              key={option.key}
              className="flex flex-col gap-4 rounded-3xl border border-line bg-paper px-4 py-4"
            >
              <div className="flex items-center gap-1">
                <p className="mr-auto text-[12.5px] font-semibold tracking-[0.14em] text-ink-muted uppercase">
                  Question {index + 1}
                </p>
                {draft.length > 1 ? (
                  <>
                    <IconButton
                      label={`Monter la question ${index + 1}`}
                      disabled={saving || index === 0}
                      onClick={() => update(moved(draft, index, -1))}
                    >
                      ↑
                    </IconButton>
                    <IconButton
                      label={`Descendre la question ${index + 1}`}
                      disabled={saving || index === draft.length - 1}
                      onClick={() => update(moved(draft, index, 1))}
                    >
                      ↓
                    </IconButton>
                  </>
                ) : null}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    update(draft.filter((item) => item.key !== option.key))
                  }
                  aria-label={`Supprimer la question ${index + 1}`}
                  className="flex h-10 cursor-pointer items-center rounded-xl px-2.5 text-[13.5px] font-medium text-danger hover:bg-danger-soft/60 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Supprimer
                </button>
              </div>

              <TextField
                label="Question posée à ta cliente"
                name={`question-${option.key}`}
                autoComplete="off"
                placeholder="Longueur, taille du motif, zone…"
                maxLength={catalogLimits.question}
                value={option.question}
                readOnly={saving}
                error={errors[option.key]}
                onChange={(event) => {
                  setOption(option.key, { question: event.target.value });
                  clear(option.key);
                }}
              />

              <div
                role="group"
                aria-label={`Réponse à la question ${index + 1}`}
                className="flex flex-col gap-1.5"
              >
                <div className="flex w-fit rounded-full bg-sand p-1">
                  {(
                    [
                      [true, "Obligatoire"],
                      [false, "Facultative"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={option.required === value}
                      disabled={saving}
                      onClick={() => setOption(option.key, { required: value })}
                      className={cn(
                        "h-9 cursor-pointer rounded-full px-4 text-[13.5px] font-medium transition-colors",
                        option.required === value
                          ? "bg-paper-raised text-ink shadow-sm"
                          : "text-ink-soft",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-[13px] text-ink-muted">
                  {option.required
                    ? "Ta cliente doit choisir une réponse pour réserver."
                    : "Ta cliente peut ne rien choisir : rien n’est alors ajouté."}
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <div
                  aria-hidden="true"
                  className="hidden grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_2.5rem] gap-2 px-1 text-[12px] text-ink-muted sm:grid"
                >
                  <span>Réponse</span>
                  <span>+ prix</span>
                  <span>+ min</span>
                </div>
                <ul className="flex flex-col gap-2">
                  {option.choices.map((choice, position) => {
                    const of = `réponse ${position + 1} de la question ${index + 1}`;
                    const problems = (["label", "price", "minutes"] as const)
                      .map((field) => errors[`${choice.key}:${field}`])
                      .filter(Boolean);
                    return (
                      <li key={choice.key} className="flex flex-col gap-1">
                        {/* A phone: her answer's name on its own line. */}
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.5rem] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_2.5rem]">
                          <Cell
                            label={`Nom, ${of}`}
                            placeholder="Naturelle, grand, jambes…"
                            className="col-span-3 sm:col-span-1"
                            maxLength={catalogLimits.choiceLabel}
                            value={choice.label}
                            readOnly={saving}
                            invalid={Boolean(errors[`${choice.key}:label`])}
                            onChange={(label) => {
                              setChoice(option, choice.key, { label });
                              clear(`${choice.key}:label`);
                            }}
                          />
                          <Cell
                            label={`Prix ajouté en euros, ${of}`}
                            placeholder="+ 0 €"
                            inputMode="decimal"
                            value={choice.price}
                            readOnly={saving}
                            invalid={Boolean(errors[`${choice.key}:price`])}
                            onChange={(price) => {
                              setChoice(option, choice.key, { price });
                              clear(`${choice.key}:price`);
                            }}
                          />
                          <Cell
                            label={`Minutes ajoutées, ${of}`}
                            placeholder="+ 0 min"
                            inputMode="numeric"
                            value={choice.minutes}
                            readOnly={saving}
                            invalid={Boolean(errors[`${choice.key}:minutes`])}
                            onChange={(minutes) => {
                              setChoice(option, choice.key, { minutes });
                              clear(`${choice.key}:minutes`);
                            }}
                          />
                          {option.choices.length > 1 ? (
                            <IconButton
                              label={`Retirer la ${of}`}
                              disabled={saving}
                              onClick={() =>
                                setOption(option.key, {
                                  choices: option.choices.filter(
                                    (item) => item.key !== choice.key,
                                  ),
                                })
                              }
                            >
                              ×
                            </IconButton>
                          ) : (
                            <span />
                          )}
                        </div>
                        {problems.length ? (
                          <p role="alert" className="text-[13px] text-danger">
                            {problems.join(" ")}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                {option.choices.length < catalogLimits.maxChoices ? (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() =>
                      setOption(option.key, {
                        choices: [...option.choices, emptyChoice()],
                      })
                    }
                    className={cn(linkAction, "mt-1 w-fit")}
                  >
                    Ajouter une réponse
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}

      {draft.length < catalogLimits.maxOptions ? (
        <Button
          variant="secondary"
          size="md"
          disabled={saving}
          onClick={() => update([...draft, emptyOption()])}
        >
          Ajouter une question
        </Button>
      ) : null}

      {invalid ? (
        <Notice tone="error" title="À corriger avant d’enregistrer">
          {invalid > 1
            ? `${invalid} champs sont à revoir, indiqués ci-dessus.`
            : "Un champ est à revoir, indiqué ci-dessus."}
        </Notice>
      ) : null}

      {failure ? (
        <Notice
          tone={failure.code === "network" ? "offline" : "error"}
          title={
            stale
              ? "Cette prestation a changé ailleurs"
              : gone
                ? "Cette prestation n’existe plus"
                : failure.code === "network"
                  ? "Pas de réponse"
                  : "Options non enregistrées"
          }
          action={
            stale || gone ? (
              <button
                type="button"
                className={linkAction}
                onClick={() => {
                  onReload();
                  if (gone) onClose();
                }}
              >
                {gone
                  ? "Revenir à mes prestations"
                  : "Reprendre les options actuelles"}
              </button>
            ) : undefined
          }
        >
          {stale
            ? "Rien n’a été enregistré. Reprends ses options actuelles pour les modifier : ce que tu as changé ici sera perdu."
            : gone
              ? "Elle a été supprimée entre-temps : rien n’a été enregistré."
              : failure.code === "network"
                ? "Rien ne dit que c’est enregistré. Réessaie : le même enregistrement ne s’applique jamais deux fois."
                : failure.code === "validation_error"
                  ? "Une valeur est refusée. Vérifie que la durée totale, avec les réponses les plus longues, ne dépasse pas 12 h."
                  : "Tes options n’ont pas pu être enregistrées. Réessaie."}
        </Notice>
      ) : null}

      {leaving ? (
        <Notice tone="warning" title="Quitter sans enregistrer ?">
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            Tes modifications seront perdues.
            <button type="button" className={linkAction} onClick={onClose}>
              Quitter
            </button>
            <button type="button" className={linkAction} onClick={onStay}>
              Continuer à modifier
            </button>
          </span>
        </Notice>
      ) : null}

      <Button
        size="md"
        state={state}
        loadingLabel="Enregistrement…"
        successLabel="Enregistré"
        disabled={!changed || stale || gone}
        onClick={() => void save()}
      >
        Enregistrer les options
      </Button>
      <p className="text-[13px] text-ink-muted">
        {changed
          ? "En ligne dès l’enregistrement : tes prochaines réservations poseront ces questions."
          : "Aucune modification."}
      </p>
    </div>
  );
}

/** A compact input of an answer's row, named for screen readers. */
function Cell({
  label,
  value,
  onChange,
  invalid,
  className,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  className?: string;
  placeholder?: string;
  maxLength?: number;
  readOnly?: boolean;
  inputMode?: "decimal" | "numeric";
}) {
  return (
    <input
      {...rest}
      aria-label={label}
      aria-invalid={invalid || undefined}
      autoComplete="off"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "h-11 w-full min-w-0 rounded-xl border bg-paper-raised px-3 text-[15px] text-ink tabular-nums outline-none placeholder:text-ink-muted focus-visible:border-ink",
        invalid ? "border-danger" : "border-line",
        className,
      )}
    />
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-10 cursor-pointer items-center justify-center rounded-xl text-[16px] text-ink-soft hover:bg-sand hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

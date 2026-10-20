"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import {
  configureLoyaltyProgramAction,
  getLoyaltyProgramAction,
} from "@/features/loyalty/actions/loyalty";
import { cn } from "@/lib/cn";

import {
  activationCommand,
  checkProgram,
  earningSummary,
  programCommand,
  programDirty,
  programDraft,
  type ProgramDraft,
  type ProgramField,
} from "../client/program-form";
import type { LoyaltyAccrualMode, LoyaltyProgramDto } from "../types";
import {
  Badge,
  Card,
  WriteError,
  fieldErrorsOf,
  linkAction,
} from "./loyalty-parts";

const programFields: Record<string, ProgramField> = {
  pointsPerCompletedAppointment: "perAppointment",
  pointsPerEuro: "perEuro",
};

type Write =
  | { status: "idle" }
  | { status: "saving"; kind: "config" | "activation" }
  | { status: "saved"; kind: "config" | "activation"; message: string }
  | { status: "error"; kind: "config" | "activation"; error: UiError }
  /** Refused as stale: the program as it is now (null while reading it). */
  | { status: "conflict"; current: LoyaltyProgramDto | null; error?: UiError };

/**
 * Activation and calculation of the program. The saved program (`program`)
 * is the base of every write (`expectedVersion`); the form is a draft on
 * top of it, never replaced behind the professional's back. A refused
 * write (`stale_loyalty_program`) shows what changed and lets her choose.
 */
export function ProgramSection({
  program,
  onProgram,
}: {
  program: LoyaltyProgramDto;
  /** A confirmed program (after a write or a re-read). */
  onProgram: (program: LoyaltyProgramDto) => void;
}) {
  const [draft, setDraft] = useState<ProgramDraft>(() => programDraft(program));
  const [errors, setErrors] = useState<Partial<Record<ProgramField, string>>>(
    {},
  );
  const [write, setWrite] = useState<Write>({ status: "idle" });
  const [confirming, setConfirming] = useState(false);
  const sending = useRef(false);
  const perAppointmentRef = useRef<HTMLInputElement>(null);
  const perEuroRef = useRef<HTMLInputElement>(null);

  const dirty = programDirty(draft, program);
  const saving = write.status === "saving";
  const configured = program.version > 0;

  function change(patch: Partial<ProgramDraft>) {
    setDraft((value) => ({ ...value, ...patch }));
    setErrors({});
    if (write.status === "saved" || write.status === "error")
      setWrite({ status: "idle" });
  }

  async function conflict() {
    setWrite({ status: "conflict", current: null });
    const result = await callAction(() => getLoyaltyProgramAction());
    setWrite(
      result.ok
        ? { status: "conflict", current: result.data }
        : { status: "conflict", current: null, error: result.error },
    );
  }

  async function send(
    command: ReturnType<typeof activationCommand>,
    kind: "config" | "activation",
  ) {
    if (sending.current) return;
    sending.current = true;
    setWrite({ status: "saving", kind });
    const result = await callAction(() =>
      configureLoyaltyProgramAction(command),
    );
    sending.current = false;
    if (kind === "activation") setConfirming(false);
    if (result.ok) {
      onProgram(result.data);
      if (kind === "config") setDraft(programDraft(result.data));
      setWrite({
        status: "saved",
        kind,
        message:
          kind === "config"
            ? "Réglages enregistrés."
            : result.data.active
              ? "Programme activé."
              : "Programme mis en pause.",
      });
      return;
    }
    if (result.error.code === "stale_loyalty_program") {
      void conflict();
      return;
    }
    if (result.error.code === "validation_error") {
      const fieldErrors = fieldErrorsOf(result.error, programFields);
      setErrors(fieldErrors);
      focusFirst(fieldErrors);
    }
    setWrite({ status: "error", kind, error: result.error });
  }

  function focusFirst(fieldErrors: Partial<Record<ProgramField, string>>) {
    if (fieldErrors.perAppointment) perAppointmentRef.current?.focus();
    else if (fieldErrors.perEuro) perEuroRef.current?.focus();
  }

  function save() {
    const checked = checkProgram(draft, program);
    if (!checked.ok) {
      setErrors(checked.errors);
      focusFirst(checked.errors);
      return;
    }
    void send(
      programCommand(
        program,
        { active: program.active, accrualMode: draft.accrualMode },
        checked,
      ),
      "config",
    );
  }

  const mode = (value: LoyaltyAccrualMode, title: string, text: string) => (
    <label
      className={cn(
        "flex cursor-pointer gap-3 rounded-2xl border px-4 py-3.5 transition-colors",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        draft.accrualMode === value
          ? "border-ink bg-paper"
          : "border-line hover:border-line-strong",
      )}
    >
      <input
        type="radio"
        name="accrual-mode"
        value={value}
        checked={draft.accrualMode === value}
        onChange={() => change({ accrualMode: value })}
        disabled={saving}
        className="mt-1 size-4 shrink-0 accent-ink"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[15px] font-semibold text-ink">{title}</span>
        <span className="text-[13.5px] leading-snug text-ink-muted">
          {text}
        </span>
      </span>
    </label>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Programme"
        description={
          program.active
            ? "Tes clientes gagnent des points à chaque rendez-vous terminé."
            : configured
              ? "Le programme est en pause : aucun point n’est gagné."
              : "Aucun programme configuré pour l’instant. Il ne démarre que quand tu l’actives."
        }
        action={
          <Badge tone={program.active ? "success" : "muted"}>
            {program.active ? "Actif" : "Inactif"}
          </Badge>
        }
      >
        <p className="text-[14.5px] text-ink">{earningSummary(program)}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            size="md"
            variant={program.active ? "secondary" : "primary"}
            onClick={() => setConfirming(true)}
            disabled={dirty || saving}
          >
            {program.active ? "Mettre en pause" : "Activer le programme"}
          </Button>
          {dirty ? (
            <p className="text-[13px] text-ink-muted">
              Enregistre ou annule tes modifications avant de{" "}
              {program.active ? "mettre en pause" : "l’activer"}.
            </p>
          ) : null}
        </div>
        {write.status === "error" && write.kind === "activation" ? (
          <WriteError error={write.error}>
            {program.active
              ? "Le programme n’a pas été mis en pause."
              : "Le programme n’a pas été activé."}
          </WriteError>
        ) : null}
        {write.status === "saved" && write.kind === "activation" ? (
          <Notice tone="success">{write.message}</Notice>
        ) : null}
      </Card>

      <Card
        title="Comment gagner des points"
        description="Les points sont gagnés quand tu marques un rendez-vous comme terminé dans l’agenda, jamais au moment de la réservation."
      >
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <fieldset className="flex flex-col gap-2" disabled={saving}>
            <legend className="mb-2 text-[15px] font-medium text-ink">
              Mode de calcul
            </legend>
            {mode(
              "appointment",
              "Par rendez-vous",
              "Le même nombre de points pour chaque rendez-vous terminé, quel que soit son prix. Simple à expliquer : « 10 points par visite ».",
            )}
            {mode(
              "spend",
              "Au montant",
              "Des points selon le prix du rendez-vous : une prestation plus chère rapporte plus. Exemple : 1 point par euro, une prestation à 65 € rapporte 65 points.",
            )}
          </fieldset>

          {draft.accrualMode === "appointment" ? (
            <TextField
              ref={perAppointmentRef}
              label="Points par rendez-vous terminé"
              inputMode="numeric"
              value={draft.perAppointment}
              onChange={(event) =>
                change({ perAppointment: event.target.value })
              }
              error={errors.perAppointment}
              hint="Un nombre entier, de 1 à 10 000."
              disabled={saving}
            />
          ) : (
            <TextField
              ref={perEuroRef}
              label="Points par euro"
              inputMode="decimal"
              value={draft.perEuro}
              onChange={(event) => change({ perEuro: event.target.value })}
              error={errors.perEuro}
              hint="Calculé sur le prix enregistré sur le rendez-vous, arrondi à l’entier inférieur. Exemple : 0,5 point par euro, 65 € → 32 points."
              disabled={saving}
            />
          )}

          {write.status === "conflict" ? (
            <ConflictNotice
              write={write}
              onRetryRead={() => void conflict()}
              onTakeCurrent={(current) => {
                onProgram(current);
                setDraft(programDraft(current));
                setErrors({});
                setWrite({ status: "idle" });
              }}
              onKeepMine={(current) => {
                onProgram(current);
                setWrite({ status: "idle" });
              }}
            />
          ) : null}
          {write.status === "error" && write.kind === "config" ? (
            <WriteError error={write.error}>
              Rien n’a été enregistré.
            </WriteError>
          ) : null}
          {write.status === "saved" && write.kind === "config" ? (
            <Notice tone="success">{write.message}</Notice>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {dirty ? (
              <Button
                variant="ghost"
                size="md"
                disabled={saving}
                onClick={() => {
                  setDraft(programDraft(program));
                  setErrors({});
                  setWrite({ status: "idle" });
                }}
              >
                Annuler les modifications
              </Button>
            ) : null}
            <Button
              type="submit"
              size="md"
              state={saving && write.kind === "config" ? "loading" : "idle"}
              loadingLabel="Enregistrement…"
              disabled={!dirty || write.status === "conflict"}
            >
              Enregistrer
            </Button>
          </div>
        </form>
      </Card>

      <ConfirmDialog
        open={confirming}
        title={
          program.active
            ? "Mettre le programme en pause ?"
            : "Activer le programme ?"
        }
        confirmLabel={program.active ? "Mettre en pause" : "Activer"}
        state={saving && write.kind === "activation" ? "loading" : "idle"}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          void send(activationCommand(program, !program.active), "activation")
        }
      >
        {program.active ? (
          <ul className="flex list-disc flex-col gap-2 pl-5 text-[14.5px] text-ink-soft">
            <li>Les rendez-vous terminés ne rapporteront plus de points.</li>
            <li>
              Aucun point n’est retiré : soldes et historique restent visibles.
            </li>
            <li>
              Tu ne pourras plus attribuer de récompense tant que le programme
              est en pause.
            </li>
          </ul>
        ) : (
          <ul className="flex list-disc flex-col gap-2 pl-5 text-[14.5px] text-ink-soft">
            <li>
              À partir de maintenant : {earningSummary(program).toLowerCase()}.
            </li>
            <li>
              Les rendez-vous déjà terminés ne rapportent rien rétroactivement.
              Tu peux créditer des points à la main depuis une fiche cliente.
            </li>
          </ul>
        )}
      </ConfirmDialog>
    </div>
  );
}

function ConflictNotice({
  write,
  onRetryRead,
  onTakeCurrent,
  onKeepMine,
}: {
  write: Extract<Write, { status: "conflict" }>;
  onRetryRead: () => void;
  onTakeCurrent: (current: LoyaltyProgramDto) => void;
  onKeepMine: (current: LoyaltyProgramDto) => void;
}) {
  const { current } = write;
  if (!current) {
    return write.error ? (
      <WriteError
        error={write.error}
        action={
          <button type="button" className={linkAction} onClick={onRetryRead}>
            Relire le programme
          </button>
        }
      >
        Le programme a été modifié ailleurs, et sa version actuelle n’a pas pu
        être lue.
      </WriteError>
    ) : (
      <Notice tone="warning">Lecture de la version actuelle…</Notice>
    );
  }
  return (
    <Notice
      tone="warning"
      title="Programme modifié entre-temps"
      action={
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <button
            type="button"
            className={linkAction}
            onClick={() => onTakeCurrent(current)}
          >
            Reprendre la version actuelle
          </button>
          <button
            type="button"
            className={linkAction}
            onClick={() => onKeepMine(current)}
          >
            Garder mes réglages
          </button>
        </div>
      }
    >
      Rien n’a été enregistré. Version actuelle : programme{" "}
      {current.active ? "actif" : "inactif"},{" "}
      {earningSummary(current).toLowerCase()}. En gardant tes réglages,
      vérifie-les puis enregistre à nouveau.
    </Notice>
  );
}

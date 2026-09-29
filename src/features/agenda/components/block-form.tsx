"use client";

import { useState, type FormEvent } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextField } from "@/components/ui/field";
import {
  createBlockAction,
  deleteBlockAction,
  updateBlockAction,
} from "@/features/agenda/actions/agenda";
import type { AgendaBlockDto } from "@/features/agenda/data/agenda";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { addDaysToLocalDate } from "@/lib/time/zoned";

import { dateOf, timeOf } from "../client/dates";
import { fieldErrorsCopy } from "../client/errors";
import { isAllDayBlock } from "../client/layout";
import { timeWithOccurrence } from "../client/occurrence";
import { AgendaError, TextAction } from "./agenda-error";

export type BlockFormMode =
  | { kind: "create"; date: string; time: string }
  | { kind: "edit"; block: AgendaBlockDto };

type Values = {
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  reason: string;
};

function initialValues(mode: BlockFormMode): Values {
  if (mode.kind === "create") {
    const [hours, minutes] = mode.time.split(":").map(Number);
    const endMinutes = Math.min(hours! * 60 + minutes! + 60, 23 * 60 + 59);
    const pad = (value: number) => String(value).padStart(2, "0");
    return {
      allDay: false,
      startDate: mode.date,
      startTime: mode.time,
      endDate: mode.date,
      endTime: `${pad(Math.floor(endMinutes / 60))}:${pad(endMinutes % 60)}`,
      reason: "",
    };
  }
  const { block } = mode;
  const allDay = isAllDayBlock(block);
  return {
    allDay,
    startDate: dateOf(block.localStartsAt),
    startTime: timeOf(block.localStartsAt),
    // Whole days are inclusive in the form, exclusive in the DTO.
    endDate: allDay
      ? addDaysToLocalDate(dateOf(block.localEndsAt), -1)
      : dateOf(block.localEndsAt),
    endTime: timeOf(block.localEndsAt),
    reason: block.reason ?? "",
  };
}

/**
 * Create, edit or delete an unavailability. Bounds are sent as wall-clock
 * values; the server resolves and orders them. No ordering check is done on
 * the local strings: during the repeated autumn hour "02:30 → 02:30" is a
 * real one-hour period, and an unchanged bound keeps its exact instant.
 */
export function BlockForm({
  mode,
  timezone,
  onSaved,
  onDeleted,
  onCancel,
  onRefresh,
}: {
  mode: BlockFormMode;
  timezone: string;
  onSaved: (block: AgendaBlockDto) => void;
  onDeleted: () => void;
  onCancel: () => void;
  /** Reloads after stale_block (edit only). */
  onRefresh?: () => Promise<UiError | null>;
}) {
  const block = mode.kind === "edit" ? mode.block : null;
  const [values, setValues] = useState<Values>(() => initialValues(mode));
  const [endTouched, setEndTouched] = useState(mode.kind === "edit");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<UiError | null>(null);
  const [submitState, setSubmitState] = useState<ButtonState>("idle");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const set = (patch: Partial<Values>) =>
    setValues((current) => ({ ...current, ...patch }));

  function blockInput() {
    const reason = values.reason.normalize("NFC").trim() || undefined;
    return values.allDay
      ? {
          allDay: true as const,
          startDate: values.startDate,
          endDate: values.endDate,
          reason,
        }
      : {
          allDay: false as const,
          startsAt: `${values.startDate}T${values.startTime}`,
          endsAt: `${values.endDate}T${values.endTime}`,
          reason,
        };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitState !== "idle") return;

    const missing: Record<string, string> = {};
    if (!values.startDate) missing.startDate = "Choisis une date.";
    if (!values.endDate) missing.endDate = "Choisis une date.";
    if (!values.allDay && !values.startTime)
      missing.startsAt = "Choisis une heure.";
    if (!values.allDay && !values.endTime)
      missing.endsAt = "Choisis une heure.";
    setFieldErrors(missing);
    if (Object.keys(missing).length > 0) return;

    setFormError(null);
    setSubmitState("loading");
    const input = blockInput();
    const result = await callAction(() =>
      block
        ? updateBlockAction({
            blockId: block.id,
            expectedVersion: block.version,
            block: input,
          })
        : createBlockAction(input),
    );

    if (result.ok) {
      setSubmitState("success");
      onSaved(result.data);
      return;
    }
    setSubmitState("idle");
    if (result.error.code === "validation_error" && result.error.fieldErrors) {
      setFieldErrors(fieldErrorsCopy(result.error));
    } else {
      setFormError(result.error);
    }
  }

  async function remove() {
    if (!block || deleting) return;
    setDeleting(true);
    const result = await callAction(() =>
      deleteBlockAction({ blockId: block.id, expectedVersion: block.version }),
    );
    setDeleting(false);
    setConfirmDelete(false);
    if (result.ok) onDeleted();
    else setFormError(result.error);
  }

  async function refresh() {
    if (!onRefresh) return;
    setRefreshing(true);
    const error = await onRefresh();
    setRefreshing(false);
    if (error) setFormError(error);
  }

  const boundLabel = (
    local: string,
    occurrence: AgendaBlockDto["startOccurrence"],
  ) => timeWithOccurrence(timeOf(local), occurrence, dateOf(local), timezone);

  return (
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-6">
      {block?.kind === "closed" ? (
        <p className="rounded-2xl bg-sand/70 px-4 py-3 text-[14px] text-ink-soft">
          Fermeture créée dans tes réglages. Tu peux la modifier ou la supprimer
          ici.
        </p>
      ) : null}

      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-2xl border border-line bg-paper-raised px-4 py-3">
        <span className="flex flex-col">
          <span className="text-[15px] font-medium text-ink">
            Journée entière
          </span>
          <span className="text-[13px] text-ink-muted">
            Du matin au soir, quelle que soit la durée du jour.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={values.allDay}
          onChange={(event) => set({ allDay: event.target.checked })}
          className="size-5 accent-[var(--ink)]"
        />
      </label>

      {values.allDay ? (
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Du"
            type="date"
            value={values.startDate}
            error={fieldErrors.startDate}
            onChange={(event) =>
              set({
                startDate: event.target.value,
                ...(endTouched ? {} : { endDate: event.target.value }),
              })
            }
          />
          <TextField
            label="Au (inclus)"
            type="date"
            value={values.endDate}
            error={fieldErrors.endDate}
            onChange={(event) => {
              setEndTouched(true);
              set({ endDate: event.target.value });
            }}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="Début — date"
              type="date"
              value={values.startDate}
              error={fieldErrors.startDate}
              onChange={(event) =>
                set({
                  startDate: event.target.value,
                  ...(endTouched ? {} : { endDate: event.target.value }),
                })
              }
            />
            <TextField
              label="Début — heure"
              type="time"
              step={300}
              value={values.startTime}
              error={fieldErrors.startsAt}
              onChange={(event) => set({ startTime: event.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="Fin — date"
              type="date"
              value={values.endDate}
              error={fieldErrors.endDate}
              onChange={(event) => {
                setEndTouched(true);
                set({ endDate: event.target.value });
              }}
            />
            <TextField
              label="Fin — heure"
              type="time"
              step={300}
              value={values.endTime}
              error={fieldErrors.endsAt}
              onChange={(event) => set({ endTime: event.target.value })}
            />
          </div>
          {block && (block.startOccurrence || block.endOccurrence) ? (
            <p className="text-[13.5px] text-ink-muted">
              Période actuelle :{" "}
              {boundLabel(block.localStartsAt, block.startOccurrence)} →{" "}
              {boundLabel(block.localEndsAt, block.endOccurrence)}. Les heures
              non modifiées sont conservées telles quelles.
            </p>
          ) : null}
        </div>
      )}

      <TextField
        label="Motif"
        optional
        maxLength={500}
        value={values.reason}
        error={fieldErrors.reason}
        placeholder="Formation, rendez-vous perso…"
        onChange={(event) => set({ reason: event.target.value })}
      />

      {formError ? (
        <AgendaError
          error={formError}
          subject="block"
          action={
            formError.code === "stale_block" && onRefresh ? (
              <TextAction onClick={refresh} disabled={refreshing}>
                {refreshing ? "Actualisation…" : "Actualiser la période"}
              </TextAction>
            ) : undefined
          }
        />
      ) : null}

      <div className="sticky -bottom-6 -mx-5 -mb-6 flex flex-col gap-2 border-t border-line bg-paper-raised px-5 pt-3 pb-[max(env(safe-area-inset-bottom),1.25rem)] sm:-mx-6 sm:px-6">
        <Button
          type="submit"
          fullWidth
          size="md"
          state={submitState}
          loadingLabel="Enregistrement…"
          successLabel="Enregistré"
        >
          {block ? "Enregistrer" : "Bloquer ce créneau"}
        </Button>
        {block ? (
          <Button
            variant="ghost"
            size="md"
            fullWidth
            onClick={() => setConfirmDelete(true)}
            disabled={submitState !== "idle"}
          >
            <span className="text-danger">Supprimer</span>
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="md"
            fullWidth
            onClick={onCancel}
            disabled={submitState !== "idle"}
          >
            Retour
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Supprimer cette période ?"
        description="Le créneau redevient disponible, y compris à la réservation en ligne."
        confirmLabel="Supprimer"
        tone="danger"
        state={deleting ? "loading" : "idle"}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={remove}
      />
    </form>
  );
}

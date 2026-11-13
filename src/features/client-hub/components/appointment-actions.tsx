"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { formatPrice } from "@/features/agenda/client/money";
import type {
  ClientHubAppointmentActionsDto,
  ClientHubAppointmentDetailDto,
  ClientHubSlotDto,
} from "@/features/client-hub/types";
import {
  addDays,
  businessToday,
  dayLabel,
  dayParts,
  wallTime,
} from "@/features/public-booking/client/business-time";

import {
  cancelAppointment,
  fetchRescheduleSlots,
  rescheduleAppointment,
  type HubResult,
} from "../client/api";
import {
  actionFailure,
  deadlineText,
  refusalText,
  type ActionFailure,
} from "../client/appointment-actions";
import { longDay, timeOf } from "../client/format";
import { useClientHub, useHubRead } from "../client/session";
import { HubErrorNotice, Loading, Skeleton, linkButton } from "./hub-parts";

// Her own changes to an upcoming appointment: cancel it, or move it to
// another slot. Shown only when the server says what is open (`actions`).
//
// - Nothing is assumed done: while a request is on its way her appointment
//   is said to be as it was, and a success is only ever the server's answer.
// - A lost answer is resent with the same request id, so it can never
//   cancel or move twice.
// - An answer that arrives for another identity than the one on screen is
//   dropped (the session's own screens take over), like every hub read.

type Mode = "idle" | "cancel" | "reschedule";

/** Days offered when moving: this many weeks from the business's today. */
const WEEKS = 8;

export function AppointmentActions({
  businessId,
  appointment,
  actions,
  onChanged,
  onStale,
}: {
  businessId: string;
  appointment: ClientHubAppointmentDetailDto;
  actions: ClientHubAppointmentActionsDto;
  /** The server confirmed a change: said to her, and the appointment read again. */
  onChanged: (message: string) => void;
  /**
   * The server refused because the appointment is no longer as shown: the
   * page says why (this panel is rebuilt by the new reading) and reads it
   * again.
   */
  onStale: (failure: ActionFailure) => void;
}) {
  const place = appointment.business;
  const zone = place.timezone;
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const send = useHubCommand();
  const ids = useRequestIds();

  const close = () => {
    if (busy) return;
    setMode("idle");
    setFailure(null);
  };

  async function run(
    what: "cancel" | "reschedule",
    key: string,
    request: (requestId: string) => Promise<HubResult<unknown>>,
    done: string,
  ): Promise<ActionFailure["next"] | "done" | "dropped"> {
    setBusy(true);
    setFailure(null);
    const result = await send(() => request(ids.for(key)));
    setBusy(false);
    // Her identity changed meanwhile: nothing of this answer is shown.
    if (result === null) return "dropped";
    if (result.ok) {
      ids.forget();
      setMode("idle");
      onChanged(done);
      return "done";
    }
    const failed = actionFailure(result.error.code, what);
    // Refused for good under this id: a later try is a new request.
    if (failed.next !== "retry") ids.forget();
    if (failed.next === "reload") {
      setMode("idle");
      onStale(failed);
    } else {
      setFailure(failed);
    }
    return failed.next;
  }

  return (
    <section
      aria-labelledby="manage-title"
      className="flex flex-col gap-4 rounded-[28px] border border-line bg-paper-raised p-5 sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <p className="text-[12.5px] font-semibold tracking-[0.14em] text-ink-muted uppercase">
          Votre rendez-vous
        </p>
        <h2
          id="manage-title"
          className="font-display text-[26px] leading-tight text-ink"
        >
          {mode === "cancel"
            ? "Annuler ce rendez-vous ?"
            : mode === "reschedule"
              ? "Choisir un nouvel horaire"
              : "Un empêchement ?"}
        </h2>
      </div>

      {failure ? (
        <Notice
          tone={failure.next === "retry" ? "offline" : "warning"}
          title={failure.title}
        >
          {failure.message}
        </Notice>
      ) : null}

      {mode === "idle" ? (
        <ul className="flex flex-col gap-3">
          <ActionRow
            label="Déplacer"
            open={actions.reschedule.allowed}
            detail={
              actions.reschedule.allowed
                ? (deadlineText(actions.reschedule, zone) ??
                  "Même prestation, même prix")
                : refusalText(
                    actions.reschedule.reason,
                    "reschedule",
                    place.name,
                  )
            }
            onClick={() => {
              setFailure(null);
              setMode("reschedule");
            }}
          />
          <ActionRow
            label="Annuler"
            open={actions.cancel.allowed}
            detail={
              actions.cancel.allowed
                ? (deadlineText(actions.cancel, zone) ?? "Sans frais")
                : refusalText(actions.cancel.reason, "cancel", place.name)
            }
            onClick={() => {
              setFailure(null);
              setMode("cancel");
            }}
          />
        </ul>
      ) : null}

      {mode === "cancel" ? (
        <div className="flex flex-col gap-4">
          <p className="text-[15px] leading-relaxed text-ink-soft">
            {appointment.serviceName},{" "}
            <span className="first-letter:lowercase">
              {longDay(appointment.startsAt, zone)}
            </span>{" "}
            à {timeOf(appointment.startsAt, zone)}. Le créneau sera libéré pour{" "}
            {place.name}, et cette annulation ne pourra pas être défaite.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="danger"
              size="md"
              state={busy ? "loading" : "idle"}
              loadingLabel="Annulation…"
              onClick={() =>
                void run(
                  "cancel",
                  "cancel",
                  (requestId) =>
                    cancelAppointment(businessId, appointment.id, {
                      requestId,
                      expectedVersion: actions.version,
                    }),
                  "Votre rendez-vous est annulé.",
                )
              }
            >
              {failure?.next === "retry"
                ? "Réessayer l’annulation"
                : "Oui, annuler"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={close}
            >
              Garder mon rendez-vous
            </Button>
          </div>
          <Pending busy={busy}>
            Votre rendez-vous reste réservé tant que l’annulation n’est pas
            confirmée.
          </Pending>
        </div>
      ) : null}

      {mode === "reschedule" ? (
        <Reschedule
          businessId={businessId}
          appointment={appointment}
          busy={busy}
          retrying={failure?.next === "retry"}
          onBack={close}
          onConfirm={(slot) =>
            run(
              "reschedule",
              `reschedule:${slot.startsAt}`,
              (requestId) =>
                rescheduleAppointment(businessId, appointment.id, {
                  requestId,
                  expectedVersion: actions.version,
                  startsAt: slot.startsAt,
                }),
              `Votre rendez-vous est déplacé au ${dayLabel(slot.localStartsAt.slice(0, 10))} à ${wallTime(slot.localStartsAt)}.`,
            )
          }
        />
      ) : null}
    </section>
  );
}

function ActionRow({
  label,
  detail,
  open,
  onClick,
}: {
  label: string;
  detail: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-paper px-4 py-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-[15px] font-semibold text-ink">{label}</span>
        <span className="text-[13.5px] leading-snug text-ink-soft first-letter:uppercase">
          {detail}
        </span>
      </div>
      {open ? (
        <Button variant="secondary" size="md" onClick={onClick}>
          {label}
        </Button>
      ) : null}
    </li>
  );
}

/** Said while a request is on its way: nothing has changed yet. */
function Pending({
  busy,
  children,
}: {
  busy: boolean;
  children: React.ReactNode;
}) {
  return (
    <p role="status" className="min-h-5 text-[13.5px] text-ink-muted">
      {busy ? children : ""}
    </p>
  );
}

function Reschedule({
  businessId,
  appointment,
  busy,
  retrying,
  onBack,
  onConfirm,
}: {
  businessId: string;
  appointment: ClientHubAppointmentDetailDto;
  busy: boolean;
  retrying: boolean;
  onBack: () => void;
  onConfirm: (
    slot: ClientHubSlotDto,
  ) => Promise<ActionFailure["next"] | "done" | "dropped">;
}) {
  const zone = appointment.business.timezone;
  const [today] = useState(() => businessToday(zone));
  const [week, setWeek] = useState(0);
  const [date, setDate] = useState(today);
  const [slot, setSlot] = useState<ClientHubSlotDto | null>(null);
  const days = Array.from({ length: 7 }, (_, index) =>
    addDays(today, week * 7 + index),
  );
  const read = useHubRead(
    `${businessId}:${appointment.id}:slots:${date}`,
    (signal) => fetchRescheduleSlots(businessId, appointment.id, date, signal),
  );

  const pick = (next: string) => {
    if (busy) return;
    setDate(next);
    setSlot(null);
  };

  async function confirm() {
    if (!slot) return;
    const outcome = await onConfirm(slot);
    // Only the target is gone: her day is read again, she chooses again.
    if (outcome === "choose-again") {
      setSlot(null);
      read.reload();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={week === 0 || busy}
          onClick={() => {
            setWeek((value) => value - 1);
            pick(addDays(today, (week - 1) * 7));
          }}
          aria-label="Semaine précédente"
          className="flex size-10 cursor-pointer items-center justify-center rounded-full border border-line text-ink disabled:cursor-default disabled:opacity-40"
        >
          <ChevronLeftIcon size={18} />
        </button>
        <ul className="grid flex-1 grid-cols-7 gap-1" aria-label="Jours">
          {days.map((day) => {
            const parts = dayParts(day);
            const selected = day === date;
            return (
              <li key={day}>
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={dayLabel(day)}
                  disabled={busy}
                  onClick={() => pick(day)}
                  className={`flex w-full cursor-pointer flex-col items-center rounded-2xl py-2 text-[12px] transition-colors ${selected ? "bg-ink text-paper-raised" : "text-ink-soft hover:bg-sand/70"}`}
                >
                  <span>{parts.weekday}</span>
                  <span className="text-[17px] font-semibold tabular-nums">
                    {parts.day}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          disabled={week >= WEEKS - 1 || busy}
          onClick={() => {
            setWeek((value) => value + 1);
            pick(addDays(today, (week + 1) * 7));
          }}
          aria-label="Semaine suivante"
          className="flex size-10 cursor-pointer items-center justify-center rounded-full border border-line text-ink disabled:cursor-default disabled:opacity-40"
        >
          <ChevronRightIcon size={18} />
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-[14px] font-semibold text-ink first-letter:uppercase">
          {dayLabel(date)}
        </p>
        {read.status === "loading" ? (
          <Loading label="Chargement des créneaux…">
            <Skeleton className="h-11 w-full rounded-2xl" />
          </Loading>
        ) : read.status === "error" ? (
          <HubErrorNotice error={read.error} onRetry={read.reload}>
            Les créneaux de ce jour n’ont pas pu être chargés.
          </HubErrorNotice>
        ) : read.data.slots.length === 0 ? (
          <p className="rounded-2xl bg-sand/60 px-4 py-3 text-[14px] text-ink-soft">
            Aucun créneau libre ce jour-là. Essayez un autre jour.
          </p>
        ) : (
          <ul
            className="grid grid-cols-3 gap-2 sm:grid-cols-4"
            aria-label={`Créneaux du ${dayLabel(date)}`}
          >
            {read.data.slots.map((item) => {
              const selected = item.startsAt === slot?.startsAt;
              return (
                <li key={item.startsAt}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    disabled={busy}
                    onClick={() => setSlot(item)}
                    className={`h-11 w-full cursor-pointer rounded-xl border text-[15px] font-medium tabular-nums transition-colors ${selected ? "border-ink bg-ink text-paper-raised" : "border-line bg-paper text-ink hover:border-line-strong"}`}
                  >
                    {wallTime(item.localStartsAt)}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {slot ? (
        <dl
          aria-label="Récapitulatif du déplacement"
          className="grid gap-px overflow-hidden rounded-[20px] border border-line bg-line sm:grid-cols-2"
        >
          <div className="bg-paper px-4 py-3">
            <dt className="text-[12.5px] text-ink-muted">Actuellement</dt>
            <dd className="text-[15px] text-ink-soft line-through decoration-line-strong first-letter:uppercase">
              {longDay(appointment.startsAt, zone)} ·{" "}
              {timeOf(appointment.startsAt, zone)}
            </dd>
          </div>
          <div className="bg-paper-raised px-4 py-3">
            <dt className="text-[12.5px] text-ink-muted">Nouvel horaire</dt>
            <dd className="text-[15px] font-semibold text-ink first-letter:uppercase">
              {dayLabel(slot.localStartsAt.slice(0, 10))} ·{" "}
              {wallTime(slot.localStartsAt)}
            </dd>
          </div>
          <div className="bg-paper px-4 py-3 sm:col-span-2">
            <dt className="text-[12.5px] text-ink-muted">
              Prestation et prix, inchangés
            </dt>
            <dd className="text-[15px] text-ink">
              {appointment.serviceName} ·{" "}
              {formatPrice(appointment.priceCents, appointment.currency)}
            </dd>
          </div>
        </dl>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button
          size="md"
          disabled={!slot}
          state={busy ? "loading" : "idle"}
          loadingLabel="Déplacement…"
          onClick={() => void confirm()}
        >
          {retrying ? "Réessayer le déplacement" : "Confirmer le déplacement"}
        </Button>
        <button
          type="button"
          disabled={busy}
          onClick={onBack}
          className={linkButton}
        >
          Ne rien changer
        </button>
      </div>
      <Pending busy={busy}>
        Votre rendez-vous reste à son horaire actuel tant que le déplacement
        n’est pas confirmé.
      </Pending>
    </div>
  );
}

/**
 * Sends a change and returns its answer only if it is still hers to see:
 * null when she signed out or changed identity meanwhile, or when the
 * answer was served for someone else (her session is then checked again).
 */
function useHubCommand() {
  const { session, accepts, isCurrent, recheck } = useClientHub();
  const owner = session.generation;
  return async function send<T>(
    request: () => Promise<HubResult<T>>,
  ): Promise<HubResult<T> | null> {
    const result = await request();
    if (!isCurrent(owner)) return null;
    const refused =
      !result.ok && result.error.code === "client_hub_unauthenticated";
    if (refused || (result.account && !accepts(owner, result.account))) {
      recheck();
      return null;
    }
    return result;
  };
}

/** One request id per content: a retry of the same content reuses it. */
function useRequestIds() {
  const last = useRef<{ key: string; id: string } | null>(null);
  return {
    for(key: string) {
      if (last.current?.key !== key)
        last.current = { key, id: crypto.randomUUID() };
      return last.current.id;
    },
    forget() {
      last.current = null;
    },
  };
}

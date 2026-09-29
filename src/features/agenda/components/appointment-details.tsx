"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextAreaField } from "@/components/ui/field";
import {
  CalendarIcon,
  ClockIcon,
  NoteIcon,
  UserIcon,
} from "@/components/ui/icons";
import {
  cancelAppointmentAction,
  setAppointmentStatusAction,
} from "@/features/agenda/actions/agenda";
import type { AgendaAppointmentDto } from "@/features/agenda/data/agenda";
import { callAction, type UiError } from "@/features/auth/client/call-action";

import { formatDuration, formatFullDate, timeOf } from "../client/dates";
import { formatPrice } from "../client/money";
import { timeWithOccurrence } from "../client/occurrence";
import { AgendaError, TextAction } from "./agenda-error";
import { StatusBadge } from "./status-badge";

type Transition = "completed" | "no_show" | "confirmed" | "cancelled";

const confirmCopy: Record<
  Transition,
  { title: string; description: string; label: string; danger?: boolean }
> = {
  completed: {
    title: "Marquer comme terminé ?",
    description: "Le rendez-vous a bien eu lieu.",
    label: "Marquer terminé",
  },
  no_show: {
    title: "Marquer comme absente ?",
    description: "La cliente ne s’est pas présentée. Le créneau reste occupé.",
    label: "Marquer absente",
  },
  confirmed: {
    title: "Remettre en confirmé ?",
    description: "Pour corriger un statut posé par erreur.",
    label: "Remettre en confirmé",
  },
  cancelled: {
    title: "Annuler ce rendez-vous ?",
    description:
      "Le rendez-vous reste dans l’historique et le créneau est libéré. Cette annulation est définitive.",
    label: "Annuler le rendez-vous",
    danger: true,
  },
};

/**
 * Content of the appointment panel. Offers the transitions that make sense
 * for the current status (a convenience: the server keeps the state machine
 * and answers invalid_status_transition otherwise).
 */
export function AppointmentDetails({
  appointment,
  timezone,
  onEdit,
  onUpdated,
  onRefresh,
}: {
  appointment: AgendaAppointmentDto;
  timezone: string;
  onEdit: () => void;
  onUpdated: (appointment: AgendaAppointmentDto) => void;
  onRefresh: () => Promise<UiError | null>;
}) {
  const [pending, setPending] = useState<Transition | null>(null);
  const [confirming, setConfirming] = useState<Transition | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Read once per opening: only used to explain why an action is unavailable.
  const [openedAt] = useState(() => Date.now());

  const date = appointment.localStartsAt.slice(0, 10);
  const start = timeWithOccurrence(
    timeOf(appointment.localStartsAt),
    appointment.startOccurrence,
    date,
    timezone,
  );
  const started = openedAt >= Date.parse(appointment.startsAt);
  const status = appointment.status;

  async function apply(transition: Transition) {
    if (pending) return;
    setPending(transition);
    setError(null);
    const result = await callAction(() =>
      transition === "cancelled"
        ? cancelAppointmentAction({
            appointmentId: appointment.id,
            expectedVersion: appointment.version,
            reason: reason.trim() || undefined,
          })
        : setAppointmentStatusAction({
            appointmentId: appointment.id,
            expectedVersion: appointment.version,
            status: transition,
          }),
    );
    setPending(null);
    setConfirming(null);
    if (result.ok) {
      setReason("");
      onUpdated(result.data);
    } else {
      setError(result.error);
    }
  }

  async function refresh() {
    setRefreshing(true);
    const refreshError = await onRefresh();
    setRefreshing(false);
    setError(refreshError);
  }

  const copy = confirming ? confirmCopy[confirming] : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <StatusBadge status={status} className="self-start" />
        <p className="font-display text-[30px] leading-tight text-ink">
          {appointment.client.displayName}
        </p>
        <p className="text-[16px] text-ink-soft">{appointment.service.name}</p>
      </div>

      {error ? (
        <AgendaError
          error={error}
          subject="appointment"
          action={
            error.code === "stale_appointment" ? (
              <TextAction onClick={refresh} disabled={refreshing}>
                {refreshing ? "Actualisation…" : "Actualiser le rendez-vous"}
              </TextAction>
            ) : error.code === "network" ? (
              <TextAction onClick={() => setError(null)}>Fermer</TextAction>
            ) : undefined
          }
        />
      ) : null}

      <dl className="grid grid-cols-1 gap-3 rounded-2xl border border-line bg-paper p-4 text-[15px]">
        <Detail icon={<CalendarIcon size={17} />} label="Date">
          <span className="first-letter:uppercase">{formatFullDate(date)}</span>
        </Detail>
        <Detail icon={<ClockIcon size={17} />} label="Heure">
          {start} – {timeOf(appointment.localEndsAt)} ·{" "}
          {formatDuration(appointment.durationMinutes)}
        </Detail>
        <Detail
          icon={<span className="text-[15px] font-semibold">€</span>}
          label="Prix"
        >
          {formatPrice(appointment.priceCents, appointment.currency)}
          <span className="text-ink-muted">
            {" "}
            · prix convenu à la réservation
          </span>
        </Detail>
        <Detail icon={<UserIcon size={17} />} label="Origine">
          {appointment.source === "public"
            ? "Réservé en ligne"
            : "Ajouté par toi"}
        </Detail>
        {appointment.internalNotes ? (
          <Detail icon={<NoteIcon size={17} />} label="Note interne">
            <span className="whitespace-pre-line">
              {appointment.internalNotes}
            </span>
          </Detail>
        ) : null}
        {appointment.cancellationReason ? (
          <Detail icon={<NoteIcon size={17} />} label="Motif d’annulation">
            {appointment.cancellationReason}
          </Detail>
        ) : null}
      </dl>

      <div className="flex flex-col gap-2.5">
        <Button variant="secondary" size="md" fullWidth onClick={onEdit}>
          {status === "confirmed" ? "Modifier" : "Modifier la note"}
        </Button>
        {status === "confirmed" || status === "no_show" ? (
          <Button
            size="md"
            fullWidth
            disabled={!started}
            onClick={() => setConfirming("completed")}
          >
            Marquer terminé
          </Button>
        ) : null}
        {status === "confirmed" ? (
          <Button
            variant="secondary"
            size="md"
            fullWidth
            disabled={!started}
            onClick={() => setConfirming("no_show")}
          >
            Marquer absente
          </Button>
        ) : null}
        {!started && status === "confirmed" ? (
          <p className="text-[13px] text-ink-muted">
            Terminé et absente sont disponibles une fois le rendez-vous
            commencé.
          </p>
        ) : null}
        {status === "completed" || status === "no_show" ? (
          <Button
            variant="ghost"
            size="md"
            fullWidth
            onClick={() => setConfirming("confirmed")}
          >
            Remettre en confirmé
          </Button>
        ) : null}
        {status === "confirmed" ? (
          <Button
            variant="ghost"
            size="md"
            fullWidth
            onClick={() => setConfirming("cancelled")}
          >
            <span className="text-danger">Annuler le rendez-vous</span>
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        title={copy?.title ?? ""}
        description={copy?.description}
        confirmLabel={copy?.label ?? ""}
        tone={copy?.danger ? "danger" : "default"}
        state={pending ? "loading" : "idle"}
        onCancel={() => setConfirming(null)}
        onConfirm={() => confirming && apply(confirming)}
      >
        {confirming === "cancelled" ? (
          <TextAreaField
            label="Motif"
            optional
            rows={2}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Empêchement de la cliente…"
          />
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

function Detail({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-sand text-ink-soft"
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-col">
        <dt className="text-[12.5px] text-ink-muted">{label}</dt>
        <dd className="text-ink">{children}</dd>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ClientHubAppointmentDetailDto } from "../types";
import { cancelHubAppointment, type HubError } from "../client/api";
import { longDay, timeOf } from "../client/format";
import { useClientHub } from "../client/session";
import { HubErrorNotice } from "./hub-parts";

export function AppointmentCancellation({
  businessId,
  appointment,
  onChanged,
}: {
  businessId: string;
  appointment: ClientHubAppointmentDetailDto;
  onChanged: () => void;
}) {
  const hub = useClientHub();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const busy = useRef(false);
  const requestId = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const actions = appointment.actions;
  if (!actions) return null;
  if (!actions.cancel.allowed) {
    return (
      <p className="text-[14px] leading-relaxed text-ink-soft">
        {actions.cancel.reason === "policy_cutoff_passed"
          ? "Le délai pour annuler en ligne est dépassé. Contactez directement l’établissement."
          : "L’annulation en ligne n’est pas ouverte pour ce rendez-vous. Contactez directement l’établissement."}
      </p>
    );
  }

  async function cancel() {
    if (busy.current || !actions || hub.session.status !== "signed-in") return;
    busy.current = true;
    setPending(true);
    setError(null);
    const owner = hub.session.generation;
    const attempt = new AbortController();
    controller.current = attempt;
    // A lost response is retried with the same idempotency key.
    requestId.current ??= crypto.randomUUID();
    try {
      const answer = await cancelHubAppointment(
        businessId,
        appointment.id,
        { requestId: requestId.current, expectedVersion: actions.version },
        attempt.signal,
      );
      if (attempt.signal.aborted || !hub.isCurrent(owner)) return;
      if (
        (answer.ok && !hub.accepts(owner, answer.account)) ||
        (answer.account && !hub.accepts(owner, answer.account)) ||
        (!answer.ok && answer.error.code === "client_hub_unauthenticated")
      ) {
        hub.distrust(owner);
        return;
      }
      setOpen(false);
      if (!answer.ok) {
        if (answer.error.code === "client_hub_not_found") hub.recheck();
        setError(answer.error);
        return;
      }
      onChanged();
    } finally {
      if (!attempt.signal.aborted && hub.isCurrent(owner)) {
        busy.current = false;
        setPending(false);
      }
    }
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <Button
        variant="danger"
        disabled={pending}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Annuler ce rendez-vous
      </Button>
      {error ? (
        <HubErrorNotice
          error={error}
          onRetry={error.code === "network" ? () => void cancel() : onChanged}
        >
          {error.code === "network"
            ? "La réponse n’a pas été reçue. L’annulation a peut-être été enregistrée : réessayer vérifie la même demande."
            : "Le rendez-vous n’a pas pu être annulé. Actualisez ses informations avant de réessayer."}
        </HubErrorNotice>
      ) : null}
      <ConfirmDialog
        open={open}
        title="Annuler ce rendez-vous ?"
        description={`${appointment.serviceName} · ${longDay(appointment.startsAt, appointment.business.timezone)} à ${timeOf(appointment.startsAt, appointment.business.timezone)}`}
        confirmLabel="Confirmer l’annulation"
        cancelLabel="Garder mon rendez-vous"
        tone="danger"
        state={pending ? "loading" : "idle"}
        onConfirm={() => void cancel()}
        onCancel={() => setOpen(false)}
      >
        <p>
          Le créneau sera libéré. Pour revenir, il faudra réserver à nouveau.
        </p>
      </ConfirmDialog>
    </div>
  );
}

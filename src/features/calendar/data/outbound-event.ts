import type { OutboundEvent } from "@/features/calendar/providers/types";

/** What the event of a mirror is derived from (a claim, or a snapshot). */
export type MirrorEventSource = {
  appointmentId: string;
  eventId: string;
  revision: number;
  startsAt: string | null;
  endsAt: string | null;
  serviceName: string | null;
  clientFirstName: string | null;
};

/**
 * The event as Google shows it: canonical instants from PostgreSQL (no
 * conversion here), the service's end (never the buffer), a first name and
 * a service name. Private metadata identifies the mirror. The writer sends
 * it, reconciliation compares listed events with it: one serializer.
 */
export function outboundEvent(source: MirrorEventSource): OutboundEvent {
  const firstName = source.clientFirstName?.trim();
  const service = source.serviceName?.trim() || "Rendez-vous";
  return {
    id: source.eventId,
    summary: (firstName ? `${firstName} — ${service}` : service).slice(0, 250),
    startsAt: source.startsAt!,
    endsAt: source.endsAt!,
    privateProperties: {
      origin: "booking-saas",
      appointmentId: source.appointmentId,
      revision: String(source.revision),
    },
  };
}

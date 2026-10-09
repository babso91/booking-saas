import "server-only";

import { z } from "zod";

import {
  decodeTimelineCursor,
  encodeTimelineCursor,
} from "@/features/crm/data/cursor";
import type { CrmContext } from "@/features/crm/data/directory";
import { businessInstants } from "@/features/crm/data/instants";
import {
  appointmentSummarySchema,
  toAppointmentSummary,
} from "@/features/crm/data/profile";
import type { ClientTimelineInput } from "@/features/crm/schemas/crm";
import type {
  BusinessInstantDto,
  ClientTimelineEvent,
  ClientTimelinePageDto,
  EmailStatus,
} from "@/features/crm/types";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// A customer's relationship history (public.crm_client_timeline), newest
// first, one bounded page at a time. One typed adapter per source; each
// event is a persisted fact. Adding a kind: a branch in the SQL union, a
// schema and an adapter here, a member of ClientTimelineEvent.

const instant = z.string();

const appointmentData = appointmentSummarySchema.extend({
  source: z.enum(["public", "manual"]),
  completedAt: instant.nullable(),
  cancellationReason: z.string().nullable(),
  contact: z.object({
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
  }),
});

const loyaltyData = z.object({
  id: z.uuid(),
  type: z.enum([
    "appointment_completed",
    "manual_adjustment",
    "reward_redeemed",
    "correction",
  ]),
  pointsDelta: z.number().int(),
  reason: z.string(),
  appointmentId: z.uuid().nullable(),
  redemption: z
    .object({
      id: z.uuid(),
      rewardId: z.uuid(),
      rewardName: z.string().nullable(),
      pointsSpent: z.number().int(),
      redeemedAt: instant,
    })
    .nullable(),
});

const emailData = z.object({
  id: z.uuid(),
  type: z.enum([
    "booking_confirmation",
    "appointment_reminder",
    "appointment_changed",
    "appointment_cancelled",
    "points_earned",
    "reward_unlocked",
    "reactivation",
  ]),
  status: z.enum(["pending", "processing", "sent", "failed", "cancelled"]),
  scheduledFor: instant,
  sentAt: instant.nullable(),
  recipientEmail: z.string(),
  appointmentId: z.uuid().nullable(),
});

const row = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("appointment"), data: appointmentData }),
  z.object({ kind: z.literal("loyalty"), data: loyaltyData }),
  z.object({ kind: z.literal("email"), data: emailData }),
]);

type TimelineRow = z.output<typeof row>;

/** Outbox status → what the professional is told (never "delivered"). */
export const EMAIL_STATUS: Record<
  z.output<typeof emailData>["status"],
  EmailStatus
> = {
  pending: "scheduled",
  processing: "sending",
  sent: "sent",
  failed: "failed",
  cancelled: "cancelled",
};

function instantsOf(event: TimelineRow): (string | null)[] {
  switch (event.kind) {
    case "appointment":
      return [event.data.startsAt, event.data.endsAt, event.data.completedAt];
    case "loyalty":
      return [event.data.redemption?.redeemedAt ?? null];
    case "email":
      return [event.data.scheduledFor, event.data.sentAt];
  }
}

function toEvent(
  id: string,
  occurredAt: BusinessInstantDto,
  event: TimelineRow,
  time: {
    at: (value: string) => BusinessInstantDto;
    optional: (value: string | null) => BusinessInstantDto | null;
  },
): ClientTimelineEvent {
  switch (event.kind) {
    case "appointment": {
      const data = event.data;
      return {
        id,
        kind: "appointment",
        occurredAt,
        appointment: {
          ...toAppointmentSummary(data, time.at),
          source: data.source,
          completedAt: time.optional(data.completedAt),
          cancellationReason: data.cancellationReason,
          contact: data.contact,
        },
      };
    }
    case "loyalty": {
      const data = event.data;
      return {
        id,
        kind: "loyalty",
        occurredAt,
        entry: {
          id: data.id,
          type: data.type,
          pointsDelta: data.pointsDelta,
          reason: data.reason,
          appointmentId: data.appointmentId,
          redemption: data.redemption
            ? {
                id: data.redemption.id,
                rewardId: data.redemption.rewardId,
                rewardName: data.redemption.rewardName,
                pointsSpent: data.redemption.pointsSpent,
                redeemedAt: time.at(data.redemption.redeemedAt),
              }
            : null,
        },
      };
    }
    case "email": {
      const data = event.data;
      return {
        id,
        kind: "email",
        occurredAt,
        email: {
          id: data.id,
          type: data.type,
          status: EMAIL_STATUS[data.status],
          scheduledFor: time.at(data.scheduledFor),
          sentAt: time.optional(data.sentAt),
          recipientEmail: data.recipientEmail,
          appointmentId: data.appointmentId,
        },
      };
    }
  }
}

export async function listClientTimeline(
  client: AppSupabaseClient,
  context: CrmContext,
  input: ClientTimelineInput,
): Promise<ClientTimelinePageDto> {
  const before = input.cursor
    ? decodeTimelineCursor(input.cursor, input.clientId)
    : null;

  const { data, error } = await client.rpc("crm_client_timeline", {
    p_business_id: context.businessId,
    p_client_id: input.clientId,
    p_limit: input.limit,
    p_as_of: before?.asOf,
    p_before_at: before?.at,
    p_before_id: before?.id,
  });

  if (error) throw databaseException(error);

  const page = data.slice(0, input.limit).map((raw) => {
    const parsed = row.safeParse({ kind: raw.kind, data: raw.data });
    if (!parsed.success) {
      throw new AppException("internal", { cause: parsed.error });
    }
    return { raw, event: parsed.data };
  });
  const time = await businessInstants(client, context.businessId, [
    ...page.map(({ raw }) => raw.occurred_at),
    ...page.flatMap(({ event }) => instantsOf(event)),
  ]);
  const asOf = data[0]?.as_of ?? before?.asOf ?? time.now;
  if (!asOf) {
    throw new AppException("internal", {
      cause: new Error("crm_client_timeline: no reference instant"),
    });
  }
  const last = page.at(-1);

  return {
    asOf: new Date(asOf).toISOString(),
    timezone: context.timezone,
    events: page.map(({ raw, event }) =>
      toEvent(raw.event_id, time.at(raw.occurred_at), event, time),
    ),
    nextCursor:
      data.length > input.limit && last
        ? encodeTimelineCursor({
            // Exact values from PostgreSQL (microseconds kept).
            asOf,
            clientId: input.clientId,
            // As returned by PostgreSQL (microseconds kept): the next page
            // starts strictly after this exact instant.
            at: last.raw.occurred_at,
            id: last.raw.event_id,
          })
        : null,
  };
}

import "server-only";

import { z } from "zod";

import { displayName, type CrmContext } from "@/features/crm/data/directory";
import { businessInstants } from "@/features/crm/data/instants";
import type {
  AppointmentSummaryDto,
  ClientProfileDto,
} from "@/features/crm/types";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// One customer's relationship profile (public.crm_client_profile): the
// current record, the shared metrics, the favourite service, the value of
// completed services and the next upcoming appointments, all at one
// reference instant. The history is read separately, page by page
// (timeline.ts).

/** Upcoming appointments returned with the profile (bounded). */
export const PROFILE_UPCOMING_LIMIT = 5;

const instant = z.string();
const status = z.enum(["confirmed", "completed", "cancelled", "no_show"]);

export const appointmentSummarySchema = z.object({
  id: z.uuid(),
  status,
  startsAt: instant,
  endsAt: instant,
  serviceId: z.uuid(),
  serviceName: z.string(),
  durationMinutes: z.number().int(),
  priceCents: z.number().int(),
  currency: z.string(),
});

const profileSchema = z.object({
  asOf: instant,
  client: z.object({
    id: z.uuid(),
    firstName: z.string(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    createdAt: instant,
    updatedAt: instant,
  }),
  activity: z.object({
    completedCount: z.number().int(),
    cancelledCount: z.number().int(),
    noShowCount: z.number().int(),
    pastConfirmedCount: z.number().int(),
    upcomingCount: z.number().int(),
    firstCompletedAt: instant.nullable(),
    lastCompletedAt: instant.nullable(),
    nextAppointmentId: z.uuid().nullable(),
    nextStartsAt: instant.nullable(),
  }),
  favoriteService: z
    .object({
      serviceId: z.uuid(),
      currentName: z.string().nullable(),
      active: z.boolean().nullable(),
      completedCount: z.number().int(),
    })
    .nullable(),
  completedValue: z.array(
    z.object({
      currency: z.string(),
      amountCents: z.number().int(),
      appointmentCount: z.number().int(),
    }),
  ),
  upcoming: z.array(appointmentSummarySchema),
});

type AppointmentSummaryRow = z.output<typeof appointmentSummarySchema>;

export function toAppointmentSummary(
  row: AppointmentSummaryRow,
  at: (value: string) => AppointmentSummaryDto["startsAt"],
): AppointmentSummaryDto {
  return {
    id: row.id,
    status: row.status,
    startsAt: at(row.startsAt),
    endsAt: at(row.endsAt),
    service: {
      id: row.serviceId,
      name: row.serviceName,
      durationMinutes: row.durationMinutes,
    },
    price: { amountCents: row.priceCents, currency: row.currency },
  };
}

export async function getClientRelationshipProfile(
  client: AppSupabaseClient,
  context: CrmContext,
  clientId: string,
): Promise<ClientProfileDto> {
  const { data, error } = await client.rpc("crm_client_profile", {
    p_business_id: context.businessId,
    p_client_id: clientId,
    p_upcoming_limit: PROFILE_UPCOMING_LIMIT,
  });

  if (error) throw databaseException(error);

  const parsed = profileSchema.safeParse(data);
  if (!parsed.success) {
    throw new AppException("internal", { cause: parsed.error });
  }
  const profile = parsed.data;
  const time = await businessInstants(client, context.businessId, [
    profile.client.createdAt,
    profile.activity.firstCompletedAt,
    profile.activity.lastCompletedAt,
    ...profile.upcoming.flatMap((row) => [row.startsAt, row.endsAt]),
  ]);
  const upcoming = profile.upcoming.map((row) =>
    toAppointmentSummary(row, time.at),
  );

  return {
    asOf: new Date(profile.asOf).toISOString(),
    timezone: time.timezone,
    client: {
      id: profile.client.id,
      displayName: displayName(
        profile.client.firstName,
        profile.client.lastName,
      ),
      firstName: profile.client.firstName,
      lastName: profile.client.lastName,
      email: profile.client.email,
      phone: profile.client.phone,
      createdAt: time.at(profile.client.createdAt),
      updatedAt: new Date(profile.client.updatedAt).toISOString(),
    },
    overview: {
      completedCount: profile.activity.completedCount,
      cancelledCount: profile.activity.cancelledCount,
      noShowCount: profile.activity.noShowCount,
      pastConfirmedCount: profile.activity.pastConfirmedCount,
      upcomingCount: profile.activity.upcomingCount,
      firstCompletedVisitAt: time.optional(profile.activity.firstCompletedAt),
      lastCompletedVisitAt: time.optional(profile.activity.lastCompletedAt),
      favoriteService: profile.favoriteService,
      completedServiceValue: profile.completedValue,
    },
    nextAppointment: upcoming[0] ?? null,
    upcoming,
  };
}

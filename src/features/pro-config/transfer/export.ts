import {
  fromDatabaseRow,
  type PreferencesRow,
} from "@/features/preferences/model";

import {
  PRO_CONFIG_FORMAT,
  PRO_CONFIG_FORMAT_VERSION,
  sealProConfig,
  type ProConfigDocument,
} from "./format";

// Reads ONE professional's configuration in an environment, for a transfer
// (docs/PRO_CONFIG_TRANSFER.md). Read-only: it writes nothing, anywhere.
// Run by an operator with a direct database connection of that environment;
// never reachable from the app (no route, no action calls it).

/**
 * One database connection (a pg.Client, or a client checked out of a
 * pool): the export reads in one read-only snapshot.
 */
export type Queryable = {
  query<R extends object>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
};

export type ExportRequest = {
  environment: string;
  businessId: string;
  /** The professional, owner of that business, whose configuration it is. */
  userId: string;
  consent: { reference: string; grantedAt: string };
  /** Services left out (tests, demonstrations), chosen on the dry run. */
  excludeServiceIds?: string[];
  /** For tests; the export's own clock otherwise. */
  now?: Date;
};

export class ExportRefused extends Error {}

export async function exportProConfig(
  db: Queryable,
  request: ExportRequest,
): Promise<ProConfigDocument> {
  await db.query("begin transaction isolation level repeatable read read only");
  try {
    const document = await read(db, request);
    await db.query("commit");
    return document;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

async function read(db: Queryable, request: ExportRequest) {
  const owner = await db.query<{ role: string }>(
    `select role from public.business_members
     where business_id = $1 and user_id = $2`,
    [request.businessId, request.userId],
  );
  if (owner.rows[0]?.role !== "owner") {
    throw new ExportRefused("not_owner");
  }

  const business = await db.query<{
    name: string;
    slug: string;
    description: string | null;
    phone: string | null;
    location: string | null;
    timezone: string;
    cancellation_policy: string | null;
    logo_path: string | null;
  }>(
    `select name, slug::text as slug, description, phone, location, timezone,
       cancellation_policy, logo_path
     from public.businesses where id = $1`,
    [request.businessId],
  );
  const settings = await db.query<{
    currency: string;
    slot_interval_minutes: number;
    buffer_minutes: number;
    minimum_booking_notice_minutes: number;
    maximum_booking_advance_days: number;
    reactivation_after_days: number;
    automatic_reactivation_enabled: boolean;
  }>(
    `select currency, slot_interval_minutes, buffer_minutes,
       minimum_booking_notice_minutes, maximum_booking_advance_days,
       reactivation_after_days, automatic_reactivation_enabled
     from public.business_settings where business_id = $1`,
    [request.businessId],
  );
  const services = await db.query<{
    id: string;
    name: string;
    description: string | null;
    duration_minutes: number;
    price_cents: number;
    active: boolean;
    display_order: number;
  }>(
    `select id, name, description, duration_minutes, price_cents, active,
       display_order
     from public.services where business_id = $1
     order by display_order, name, id`,
    [request.businessId],
  );
  const hours = await db.query<{
    weekday: number;
    starts_at: string;
    ends_at: string;
  }>(
    `select weekday, to_char(starts_at, 'HH24:MI') as starts_at,
       to_char(ends_at, 'HH24:MI') as ends_at
     from public.business_hours where business_id = $1
     order by weekday, starts_at`,
    [request.businessId],
  );
  const preferences = await db.query<PreferencesRow>(
    `select style, ambiance, color_mode, accent, motion, version
     from public.member_preferences
     where business_id = $1 and user_id = $2`,
    [request.businessId, request.userId],
  );
  const counts = await db.query<{ clients: number; appointments: number }>(
    `select
       (select count(*)::int from public.clients where business_id = $1) as clients,
       (select count(*)::int from public.appointments where business_id = $1) as appointments`,
    [request.businessId],
  );

  const source = business.rows[0];
  const setting = settings.rows[0];
  if (!source || !setting) throw new ExportRefused("business_not_found");

  const excluded = new Set(request.excludeServiceIds ?? []);
  const row = preferences.rows[0];

  return sealProConfig({
    format: PRO_CONFIG_FORMAT,
    formatVersion: PRO_CONFIG_FORMAT_VERSION,
    exportedAt: (request.now ?? new Date()).toISOString(),
    source: {
      environment: request.environment,
      businessId: request.businessId,
      userId: request.userId,
    },
    consent: request.consent,
    business: {
      name: source.name,
      slug: source.slug,
      description: source.description,
      phone: source.phone,
      location: source.location,
      timezone: source.timezone,
      cancellationPolicy: source.cancellation_policy,
    },
    settings: {
      currency: setting.currency,
      slotIntervalMinutes: setting.slot_interval_minutes,
      bufferMinutes: setting.buffer_minutes,
      minimumBookingNoticeMinutes: setting.minimum_booking_notice_minutes,
      maximumBookingAdvanceDays: setting.maximum_booking_advance_days,
      reactivationAfterDays: setting.reactivation_after_days as
        30 | 45 | 60 | 90,
      automaticReactivationEnabled: setting.automatic_reactivation_enabled,
    },
    services: services.rows
      .filter((service) => !excluded.has(service.id))
      .map((service) => ({
        sourceId: service.id,
        name: service.name,
        description: service.description,
        durationMinutes: service.duration_minutes,
        priceCents: service.price_cents,
        active: service.active,
        displayOrder: service.display_order,
      })),
    hours: hours.rows.map((range) => ({
      weekday: range.weekday,
      startsAt: range.starts_at,
      endsAt: range.ends_at,
    })),
    memberPreferences: row
      ? { appearance: fromDatabaseRow(row).appearance }
      : null,
    assets: source.logo_path
      ? [{ kind: "logo", path: source.logo_path, transferred: false }]
      : [],
    excluded: {
      services: services.rows
        .filter((service) => excluded.has(service.id))
        .map((service) => service.id),
      clients: counts.rows[0]?.clients ?? 0,
      appointments: counts.rows[0]?.appointments ?? 0,
    },
  });
}

import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, inject } from "vitest";

import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { Database } from "@/types/database.generated";

export const env = inject("supabase");

/**
 * Direct connection as `postgres` (bypasses RLS). Used only to arrange test
 * data and to inspect results, never to exercise the behaviour under test.
 */
export const db = new pg.Pool({ connectionString: env.dbUrl, max: 12 });

afterAll(async () => {
  await db.end();
});

const clientOptions = {
  auth: { autoRefreshToken: false, persistSession: false },
} as const;

/** Unauthenticated client using the publishable key, exactly like the public site. */
export function anonClient(): AppSupabaseClient {
  return createClient<Database>(env.apiUrl, env.anonKey, clientOptions);
}

const adminClient = createClient<Database>(
  env.apiUrl,
  env.serviceRoleKey,
  clientOptions,
);

export type Professional = {
  userId: string;
  email: string;
  client: AppSupabaseClient;
};

/** Creates a real Supabase Auth user and returns a client signed in as them. */
export async function createProfessional(label: string): Promise<Professional> {
  const email = `${label}-${randomUUID().slice(0, 8)}@test.local`;
  const password = `Pw-${randomUUID()}`;

  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw error ?? new Error("User creation failed");
  }

  const client = anonClient();
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    throw signInError;
  }

  return { userId: data.user.id, email, client };
}

export function uniqueSlug(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export type BusinessSettings = {
  slot_interval_minutes?: number;
  buffer_minutes?: number;
  minimum_booking_notice_minutes?: number;
  maximum_booking_advance_days?: number;
};

export type TestBusiness = { id: string; slug: string; timezone: string };

export async function createBusiness(
  ownerId: string,
  options: {
    name?: string;
    slug?: string;
    timezone?: string;
    settings?: BusinessSettings;
  } = {},
): Promise<TestBusiness> {
  const slug = options.slug ?? uniqueSlug("studio");
  const timezone = options.timezone ?? "Europe/Paris";

  const { rows } = await db.query<{ id: string }>(
    `insert into public.businesses (name, slug, contact_email, timezone, created_by)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      options.name ?? `Studio ${slug}`,
      slug,
      `${slug}@test.local`,
      timezone,
      ownerId,
    ],
  );
  const id = rows[0]!.id;

  await db.query(
    `insert into public.business_members (business_id, user_id, role)
     values ($1, $2, 'owner')`,
    [id, ownerId],
  );

  await updateSettings(id, options.settings ?? {});

  return { id, slug, timezone };
}

export async function updateSettings(
  businessId: string,
  settings: BusinessSettings,
) {
  const entries = Object.entries(settings);

  if (entries.length === 0) return;

  await db.query(
    `update public.business_settings
     set ${entries.map(([column], index) => `${column} = $${index + 2}`).join(", ")}
     where business_id = $1`,
    [businessId, ...entries.map(([, value]) => value)],
  );
}

export async function createService(
  businessId: string,
  options: {
    name?: string;
    durationMinutes?: number;
    priceCents?: number;
    active?: boolean;
  } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.services (business_id, name, duration_minutes, price_cents, active)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      businessId,
      options.name ?? "Pose cil à cil",
      options.durationMinutes ?? 60,
      options.priceCents ?? 6500,
      options.active ?? true,
    ],
  );

  return rows[0]!.id;
}

/** Weekly ranges: [weekday (0 = Sunday), "HH:MM", "HH:MM"]. */
export async function setWeeklyHours(
  businessId: string,
  ranges: [number, string, string][],
) {
  await db.query("delete from public.business_hours where business_id = $1", [
    businessId,
  ]);

  for (const [weekday, startsAt, endsAt] of ranges) {
    await db.query(
      `insert into public.business_hours (business_id, weekday, starts_at, ends_at)
       values ($1, $2, $3, $4)`,
      [businessId, weekday, startsAt, endsAt],
    );
  }
}

/** Same ranges every day of the week, so tests do not depend on the weekday. */
export function everyDay(
  ...ranges: [string, string][]
): [number, string, string][] {
  return [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) =>
    ranges.map(
      ([start, end]) => [weekday, start, end] as [number, string, string],
    ),
  );
}

export async function addException(
  businessId: string,
  kind: "closed" | "blocked" | "open_override",
  startsAt: string,
  endsAt: string,
) {
  await db.query(
    `insert into public.availability_exceptions (business_id, kind, starts_at, ends_at)
     values ($1, $2, $3, $4)`,
    [businessId, kind, startsAt, endsAt],
  );
}

export async function createClientRecord(
  businessId: string,
  email: string,
  firstName = "Cliente",
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.clients (business_id, first_name, email)
     values ($1, $2, $3)
     returning id`,
    [businessId, firstName, email],
  );

  return rows[0]!.id;
}

/** Inserts an appointment directly (as postgres) for arrangement purposes. */
export async function insertAppointment(options: {
  businessId: string;
  clientId: string;
  serviceId: string;
  startsAt: string;
  endsAt: string;
  status?: "confirmed" | "completed" | "cancelled" | "no_show";
  bufferMinutes?: number;
}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.appointments (
       business_id, client_id, service_id, starts_at, ends_at, status,
       service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot,
       buffer_minutes_snapshot
     )
     select $1, $2, s.id, $4, $5, $6, s.name, s.duration_minutes, s.price_cents, $7
     from public.services s
     where s.id = $3
     returning id`,
    [
      options.businessId,
      options.clientId,
      options.serviceId,
      options.startsAt,
      options.endsAt,
      options.status ?? "confirmed",
      options.bufferMinutes ?? 0,
    ],
  );

  return rows[0]!.id;
}

/** A calendar date `days` days after today (UTC), as `YYYY-MM-DD`. */
export function dateInDays(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

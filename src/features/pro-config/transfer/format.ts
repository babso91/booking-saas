import { createHash } from "node:crypto";

import { z } from "zod";

import { appearancePreferencesSchema } from "@/features/preferences/model";

// The configuration of ONE professional, as it may move from one
// environment to another (staging → production for the pilots), with her
// consent, by an operator: docs/PRO_CONFIG_TRANSFER.md. Versioned, closed
// (any unknown field is refused), and sealed by a checksum.
//
// What it holds, by allowlist: the business's public profile, its booking
// settings, its services, its weekly hours and her own preferences. Nothing
// else, by construction: no client, no appointment, no note, no loyalty
// movement, no email, no calendar connection (tokens), no Auth account, no
// password, no session. Logo and photos (Storage) are declared, never
// carried, in this version.

export const PRO_CONFIG_FORMAT = "booking.professional-config";
export const PRO_CONFIG_FORMAT_VERSION = 1;

const uuid = z.uuid();
const time = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const text = (max: number) => z.string().min(1).max(max);

export const proConfigServiceSchema = z
  .object({
    /** The service's id in the source: the link kept by the destination. */
    sourceId: uuid,
    name: text(120),
    description: z.string().max(1000).nullable(),
    durationMinutes: z.number().int().min(5).max(720),
    priceCents: z.number().int().min(0).max(100_000_000),
    active: z.boolean(),
    displayOrder: z.number().int().min(0).max(100_000),
  })
  .strict();

export const proConfigHoursSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startsAt: time,
    endsAt: time,
  })
  .strict()
  .refine((range) => range.startsAt < range.endsAt, {
    message: "Une plage horaire doit finir après son début.",
  });

const payloadSchema = z
  .object({
    format: z.literal(PRO_CONFIG_FORMAT),
    formatVersion: z.literal(PRO_CONFIG_FORMAT_VERSION),
    exportedAt: z.iso.datetime({ offset: true }),
    source: z
      .object({
        /** "staging", "local"…: where it comes from, for the operator. */
        environment: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
        businessId: uuid,
        userId: uuid,
      })
      .strict(),
    /** Her written consent to this transfer (reference, date). */
    consent: z
      .object({
        reference: text(200),
        grantedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
    business: z
      .object({
        name: text(120),
        slug: z
          .string()
          .min(3)
          .max(63)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        description: z.string().max(1000).nullable(),
        phone: z
          .string()
          .regex(/^\+?[0-9 ().-]{6,30}$/)
          .nullable(),
        location: z.string().max(500).nullable(),
        timezone: text(64),
        cancellationPolicy: z.string().max(5000).nullable(),
      })
      .strict(),
    settings: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        slotIntervalMinutes: z.number().int().min(5).max(120),
        bufferMinutes: z.number().int().min(0).max(240),
        minimumBookingNoticeMinutes: z.number().int().min(0).max(10080),
        maximumBookingAdvanceDays: z.number().int().min(1).max(365),
        reactivationAfterDays: z.union([
          z.literal(30),
          z.literal(45),
          z.literal(60),
          z.literal(90),
        ]),
        automaticReactivationEnabled: z.boolean(),
      })
      .strict(),
    services: z.array(proConfigServiceSchema).max(500),
    hours: z.array(proConfigHoursSchema).max(7 * 48),
    memberPreferences: z
      .object({ appearance: appearancePreferencesSchema })
      .strict()
      .nullable(),
    /** Storage objects (logo, photos): declared, not carried, in v1. */
    assets: z
      .array(
        z
          .object({
            kind: z.enum(["logo"]),
            path: z.string().max(500),
            transferred: z.literal(false),
          })
          .strict(),
      )
      .max(50),
    /** What the source had and was left out on purpose, as counts. */
    excluded: z
      .object({
        services: z.array(uuid),
        clients: z.number().int().min(0),
        appointments: z.number().int().min(0),
      })
      .strict(),
  })
  .strict()
  .superRefine((payload, context) => {
    const ids = new Set<string>();
    for (const service of payload.services) {
      if (ids.has(service.sourceId)) {
        context.addIssue({
          code: "custom",
          message: "Prestation en double.",
          path: ["services"],
        });
      }
      ids.add(service.sourceId);
    }
    const sorted = [...payload.hours].sort(
      (a, b) => a.weekday - b.weekday || a.startsAt.localeCompare(b.startsAt),
    );
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1]!;
      const range = sorted[index]!;
      if (
        previous.weekday === range.weekday &&
        range.startsAt < previous.endsAt
      ) {
        context.addIssue({
          code: "custom",
          message: "Plages horaires qui se chevauchent.",
          path: ["hours"],
        });
      }
    }
  });

export type ProConfigPayload = z.output<typeof payloadSchema>;
export type ProConfigDocument = ProConfigPayload & { checksum: string };

/** JSON with keys sorted at every level: the same bytes for the same data. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function checksumOf(payload: ProConfigPayload) {
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

/** Seals a payload (validated first). */
export function sealProConfig(payload: ProConfigPayload): ProConfigDocument {
  const valid = payloadSchema.parse(payload);
  return { ...valid, checksum: checksumOf(valid) };
}

export type OpenResult =
  | { ok: true; document: ProConfigDocument }
  | { ok: false; reason: "invalid" | "checksum_mismatch"; issues?: string[] };

/**
 * Reads a document strictly: its shape, then its checksum (a document
 * edited by hand after export is refused).
 */
export function openProConfig(raw: unknown): OpenResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "invalid" };
  }
  const { checksum, ...rest } = raw as Record<string, unknown>;
  const parsed = payloadSchema.safeParse(rest);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    };
  }
  if (typeof checksum !== "string" || checksum !== checksumOf(parsed.data)) {
    return { ok: false, reason: "checksum_mismatch" };
  }
  return { ok: true, document: { ...parsed.data, checksum } };
}

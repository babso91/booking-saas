"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import { readBusinessTime } from "@/lib/time/business-time";

import { localDateSchema, localTimeSchema } from "../schemas/availability";

const dateHoursKey = z.object({ businessId: z.uuid(), date: localDateSchema });
const range = z
  .object({ startsAt: localTimeSchema, endsAt: localTimeSchema })
  .refine(({ startsAt, endsAt }) => startsAt < endsAt, {
    message: "La fin doit être après le début.",
    path: ["endsAt"],
  });

/** Ranges of one date, as the editor sends them (12 at most, disjoint). */
const ranges = z
  .array(range)
  .min(1, "Ajoute au moins une plage.")
  .max(12, "12 plages au plus par date.")
  .superRefine((items, ctx) => {
    const sorted = [...items].sort((a, b) =>
      a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0,
    );
    if (
      sorted.some((item, i) => i > 0 && item.startsAt < sorted[i - 1]!.endsAt)
    )
      ctx.addIssue({
        code: "custom",
        message: "Deux plages de cette date se chevauchent.",
      });
  });

const editDateHours = dateHoursKey.extend({
  /** Null restores the usual hours of that weekday. */
  ranges: ranges.nullable(),
  /** The ranges read by the editor (null when the date had none). */
  expected: z.array(range).max(12).nullable(),
});

type Range = { startsAt: string; endsAt: string };
const toRange = (row: { starts_at: string; ends_at: string }): Range => ({
  startsAt: row.starts_at.slice(0, 5),
  endsAt: row.ends_at.slice(0, 5),
});
const toRow = (item: Range) => ({
  starts_at: item.startsAt,
  ends_at: item.endsAt,
});
/** 0 = Sunday … 6 = Saturday, as business_hours stores it. */
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

function requireScheduleAccess(
  context: { businessId: string; role: string },
  expectedBusinessId: string,
) {
  if (
    context.businessId !== expectedBusinessId ||
    context.role === "practitioner"
  ) {
    throw new AppException("forbidden");
  }
}

/** The next customised dates (30 at most), each with all its ranges. */
export async function listDateHoursAction(input: unknown) {
  return runBusinessAction(
    z.object({ businessId: z.uuid() }),
    input,
    async (context, data) => {
      requireScheduleAccess(context, data.businessId);
      const { client, businessId } = context;
      const { today } = await readBusinessTime(client, businessId);
      const { data: rows, error } = await client
        .from("business_date_hours")
        .select("date, starts_at, ends_at")
        .eq("business_id", businessId)
        .gte("date", today)
        .order("date")
        .order("starts_at")
        .limit(30 * 12);
      if (error) throw databaseException(error);
      const dates: { date: string; ranges: Range[] }[] = [];
      for (const row of rows) {
        const last = dates.at(-1);
        if (last?.date === row.date) last.ranges.push(toRange(row));
        else dates.push({ date: row.date, ranges: [toRange(row)] });
      }
      return dates.slice(0, 30);
    },
  );
}

/**
 * The ranges saved for one date (null when it follows the usual hours),
 * and the usual ranges of its weekday, from which the editor starts.
 */
export async function readDateHoursAction(input: unknown) {
  return runBusinessAction(dateHoursKey, input, async (context, data) => {
    requireScheduleAccess(context, data.businessId);
    const [saved, usual] = await Promise.all([
      context.client
        .from("business_date_hours")
        .select("starts_at, ends_at")
        .eq("business_id", context.businessId)
        .eq("date", data.date)
        .order("starts_at"),
      context.client
        .from("business_hours")
        .select("starts_at, ends_at")
        .eq("business_id", context.businessId)
        .eq("weekday", weekdayOf(data.date))
        .order("starts_at"),
    ]);
    if (saved.error) throw databaseException(saved.error);
    if (usual.error) throw databaseException(usual.error);
    return {
      ranges: saved.data.length ? saved.data.map(toRange) : null,
      usual: usual.data.map(toRange),
    };
  });
}

export async function saveDateHoursAction(input: unknown) {
  const result = await runBusinessAction(
    editDateHours,
    input,
    async (context, data) => {
      requireScheduleAccess(context, data.businessId);
      const { data: rows, error } = await context.client.rpc(
        "set_business_date_ranges",
        {
          p_business_id: context.businessId,
          p_date: data.date,
          p_ranges: data.ranges?.map(toRow) ?? null,
          p_expected: data.expected?.map(toRow) ?? null,
        },
      );
      if (error) throw databaseException(error);
      return rows.length ? rows.map(toRange) : null;
    },
  );
  if (result.ok) {
    revalidatePath("/app", "layout");
    revalidatePath("/b/[slug]", "page");
  }
  return result;
}

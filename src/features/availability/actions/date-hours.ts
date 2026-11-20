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

const editDateHours = dateHoursKey.extend({
  hours: range.nullable(),
  expected: range.nullable(),
});

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
        .limit(30);
      if (error) throw databaseException(error);
      return rows.map((row) => ({
        date: row.date,
        startsAt: row.starts_at.slice(0, 5),
        endsAt: row.ends_at.slice(0, 5),
      }));
    },
  );
}

export async function readDateHoursAction(input: unknown) {
  return runBusinessAction(dateHoursKey, input, async (context, data) => {
    requireScheduleAccess(context, data.businessId);
    const { data: row, error } = await context.client
      .from("business_date_hours")
      .select("starts_at, ends_at")
      .eq("business_id", context.businessId)
      .eq("date", data.date)
      .maybeSingle();
    if (error) throw databaseException(error);
    return row
      ? { startsAt: row.starts_at.slice(0, 5), endsAt: row.ends_at.slice(0, 5) }
      : null;
  });
}

export async function saveDateHoursAction(input: unknown) {
  const result = await runBusinessAction(
    editDateHours,
    input,
    async (context, data) => {
      requireScheduleAccess(context, data.businessId);
      const { error } = await context.client.rpc("set_business_date_hours", {
        p_business_id: context.businessId,
        p_date: data.date,
        p_starts_at: data.hours?.startsAt,
        p_ends_at: data.hours?.endsAt,
        p_expected_starts_at: data.expected?.startsAt,
        p_expected_ends_at: data.expected?.endsAt,
      });
      if (error) throw databaseException(error);
      return data.hours;
    },
  );
  if (result.ok) {
    revalidatePath("/app", "layout");
    revalidatePath("/b/[slug]", "page");
  }
  return result;
}

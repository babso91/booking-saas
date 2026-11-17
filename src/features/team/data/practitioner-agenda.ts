import "server-only";

import type { OptionSnapshot } from "@/features/catalog/model";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

/**
 * A practitioner's own appointments (docs/TEAM_CONTRACT.md, « Rôle
 * praticienne »): `practitioner_agenda`, the only reading of the agenda
 * open to her. The professional agenda joins the customers' rows, which
 * she may not read; this one returns their name and contact only.
 */

export type PractitionerVisitDto = {
  id: string;
  version: number;
  status: "confirmed" | "completed" | "cancelled" | "no_show";
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  serviceName: string;
  options: OptionSnapshot[];
  internalNotes: string | null;
  client: {
    id: string;
    firstName: string;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  };
};

/** 62 days at most, server-side. */
export const PRACTITIONER_RANGE_MAX_DAYS = 62;

export async function getPractitionerAgenda(
  client: AppSupabaseClient,
  businessId: string,
  range: { from: Date; to: Date },
): Promise<PractitionerVisitDto[]> {
  const { data, error } = await client.rpc("practitioner_agenda", {
    p_business_id: businessId,
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
  });
  if (error) throw databaseException(error);
  return (data ?? []) as unknown as PractitionerVisitDto[];
}

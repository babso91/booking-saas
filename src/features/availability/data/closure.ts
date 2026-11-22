import "server-only";

import { localStartToUtc } from "@/features/agenda/data/agenda";
import type { ClosureCommitInput } from "@/features/availability/schemas/closure";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { readBusinessTime } from "@/lib/time/business-time";

export type ClosureAppointment = {
  id: string;
  version: number;
  startsAt: string;
  endsAt: string;
  localStartsAt: string;
  localEndsAt: string;
  /** Already begun: she cannot be told, nor can it move to the past. */
  begun: boolean;
  serviceName: string;
  durationMinutes: number;
  client: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  };
};

export type ClosurePreview = {
  startsAt: string;
  endsAt: string;
  timeZone: string;
  appointments: ClosureAppointment[];
};

export type ClosureDone = {
  closureId: string;
  cancelled: string[];
  moved: string[];
  notified: number;
};

type DbError = Parameters<typeof databaseException>[0] & { details?: string };
type Rpc = { data: unknown; error: DbError | null };
type RpcCaller = (fn: string, args: object) => Promise<Rpc>;

async function call<T>(client: AppSupabaseClient, fn: string, args: object) {
  const { data, error } = await (client.rpc as unknown as RpcCaller)(fn, args);
  if (error) {
    // The appointment a refusal is about, named in DETAIL.
    if (
      error.details &&
      ["closure_conflict", "closure_stale", "invalid_input"].includes(
        error.message ?? "",
      )
    ) {
      const code =
        error.message === "invalid_input"
          ? "validation_error"
          : (error.message as "closure_conflict" | "closure_stale");
      throw new AppException(code, {
        cause: error,
        fieldErrors: { appointmentId: [error.details] },
      });
    }
    throw databaseException(error);
  }
  return data as T;
}

export const previewClosure = (
  client: AppSupabaseClient,
  businessId: string,
  startDate: string,
  endDate: string,
) =>
  call<ClosurePreview>(client, "closure_preview", {
    p_business_id: businessId,
    p_start_date: startDate,
    p_end_date: endDate,
  });

/** The local times of the moves, as instants (the agenda's own rule). */
async function moveInstants(
  client: AppSupabaseClient,
  businessId: string,
  decisions: ClosureCommitInput["decisions"],
) {
  const locals = [
    ...new Set(decisions.flatMap((d) => (d.moveTo ? [d.moveTo] : []))),
  ];
  const instants = new Map<string, ReturnType<typeof readBusinessTime>>();
  // At most 16 local times per read.
  for (let i = 0; i < locals.length; i += 16) {
    const chunk = locals.slice(i, i + 16);
    const time = readBusinessTime(client, businessId, { locals: chunk });
    for (const local of chunk) instants.set(local, time);
  }
  return Promise.all(
    decisions.map(async (decision) => {
      if (!decision.moveTo) return null;
      const time = await instants.get(decision.moveTo)!;
      try {
        return localStartToUtc(
          time.local(decision.moveTo),
          decision.occurrence,
        ).toISOString();
      } catch (error) {
        if (!(error instanceof AppException)) throw error;
        throw new AppException(error.code, {
          cause: error,
          fieldErrors: {
            ...error.fieldErrors,
            appointmentId: [decision.appointmentId],
          },
        });
      }
    }),
  );
}

export async function commitClosure(
  client: AppSupabaseClient,
  businessId: string,
  input: ClosureCommitInput,
) {
  const moves = await moveInstants(client, businessId, input.decisions);
  return call<ClosureDone>(client, "closure_commit", {
    p_business_id: businessId,
    p_request_id: input.requestId,
    p_start_date: input.startDate,
    p_end_date: input.endDate,
    p_reason: input.reason || null,
    p_message: input.message || null,
    p_decisions: input.decisions.map((decision, index) => ({
      appointmentId: decision.appointmentId,
      expectedVersion: decision.expectedVersion,
      moveTo: moves[index],
    })),
  });
}

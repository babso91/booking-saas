import "server-only";

import type { z } from "zod";

import {
  getBusinessContext,
  type BusinessContext,
} from "@/features/businesses/data/business-context";
import {
  AppException,
  toAppError,
  validationException,
  type ActionResult,
} from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { AppSupabaseClient } from "@/lib/supabase/types";

export type BusinessActionContext = BusinessContext & {
  client: AppSupabaseClient;
};

/**
 * Common skeleton of professional Server Actions:
 * authenticate → resolve the tenant from the session → validate input → run.
 *
 * The client carries the user's session, so RLS applies to every query the
 * handler issues. Errors are returned as stable codes, never thrown to the UI.
 */
export async function runBusinessAction<Schema extends z.ZodType, T>(
  schema: Schema,
  input: unknown,
  handler: (
    context: BusinessActionContext,
    data: z.output<Schema>,
  ) => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    const client = await createServerSupabaseClient();
    const context = await getBusinessContext(client);
    const parsed = schema.safeParse(input);

    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    return {
      ok: true,
      data: await handler({ ...context, client }, parsed.data),
    };
  } catch (error) {
    if (!(error instanceof AppException) || error.code === "internal") {
      console.error("Business action failed", error);
    }

    return { ok: false, error: toAppError(error) };
  }
}

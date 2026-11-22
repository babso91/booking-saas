"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  createBlock,
  deleteBlock,
  listUpcomingClosures,
} from "@/features/agenda/data/blocks";
import {
  blockDaysSchema,
  deleteBlockSchema,
} from "@/features/agenda/schemas/agenda";
import {
  commitClosure,
  previewClosure,
} from "@/features/availability/data/closure";
import {
  closureCommitSchema,
  closurePreviewSchema,
} from "@/features/availability/schemas/closure";
import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import { AppException } from "@/lib/errors";

const scope = z.object({ businessId: z.uuid() });

function requireScope(
  context: { businessId: string; role: string },
  businessId: string,
) {
  if (context.businessId !== businessId || context.role === "practitioner") {
    throw new AppException("forbidden");
  }
}

function refreshSchedule() {
  revalidatePath("/app", "layout");
  revalidatePath("/b/[slug]", "page");
}

export async function listClosuresAction(input: unknown) {
  return runBusinessAction(scope, input, (context, data) => {
    requireScope(context, data.businessId);
    return listUpcomingClosures(context.client, context);
  });
}

export async function createClosureAction(input: unknown) {
  const result = await runBusinessAction(
    scope.extend({ id: z.uuid(), days: blockDaysSchema }),
    input,
    (context, data) => {
      requireScope(context, data.businessId);
      return createBlock(context.client, context, data.days, { id: data.id });
    },
  );
  if (result.ok) refreshSchedule();
  return result;
}

export async function removeClosureAction(input: unknown) {
  const result = await runBusinessAction(
    deleteBlockSchema.extend(scope.shape),
    input,
    async (context, data) => {
      requireScope(context, data.businessId);
      try {
        await deleteBlock(
          context.client,
          context,
          data.blockId,
          data.expectedVersion,
          "closed",
        );
      } catch (error) {
        if (
          !(error instanceof AppException) ||
          error.code !== "block_not_found"
        )
          throw error;
      }
      return null;
    },
  );
  if (result.ok) refreshSchedule();
  return result;
}

/** The appointments an unexpected closure of these dates would touch. */
export async function previewClosureAction(input: unknown) {
  return runBusinessAction(closurePreviewSchema, input, (context, data) => {
    requireScope(context, data.businessId);
    return previewClosure(
      context.client,
      data.businessId,
      data.startDate,
      data.endDate,
    );
  });
}

/** Closes the dates and cancels or moves each appointment, all or nothing. */
export async function commitClosureAction(input: unknown) {
  const result = await runBusinessAction(
    closureCommitSchema,
    input,
    (context, data) => {
      requireScope(context, data.businessId);
      return commitClosure(context.client, data.businessId, data);
    },
  );
  if (result.ok) refreshSchedule();
  return result;
}

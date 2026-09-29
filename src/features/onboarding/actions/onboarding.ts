"use server";

import { revalidatePath } from "next/cache";

import { getSessionState } from "@/features/auth/data/session";
import {
  checkSlugAvailability,
  completeOnboarding,
  type OnboardedBusinessDto,
  type SlugAvailabilityDto,
} from "@/features/onboarding/data/onboarding";
import {
  checkSlugSchema,
  completeOnboardingSchema,
} from "@/features/onboarding/schemas/onboarding";
import {
  AppException,
  toAppError,
  validationException,
  type ActionResult,
} from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";

async function run<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    if (!(error instanceof AppException) || error.code === "internal") {
      console.error("Onboarding action failed", error);
    }

    return { ok: false, error: toAppError(error) };
  }
}

/**
 * Completes onboarding for the signed-in user. On success the UI goes to
 * `next` ("/app"). A second call (double click, retry after a lost response)
 * returns `already_onboarded`: the UI should then also go to "/app".
 */
export async function completeOnboardingAction(
  input: unknown,
): Promise<ActionResult<OnboardedBusinessDto & { next: "/app" }>> {
  return run(async () => {
    const client = await createServerSupabaseClient();
    const state = await getSessionState(client);

    if (state.status === "unauthenticated") {
      throw new AppException("unauthenticated");
    }
    if (state.status === "ready") {
      throw new AppException("already_onboarded");
    }

    const parsed = completeOnboardingSchema.safeParse(input);

    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    const business = await completeOnboarding(client, parsed.data);

    revalidatePath("/", "layout");
    return { ...business, next: "/app" as const };
  });
}

/** Normalises a candidate slug and reports whether it can be used right now. */
export async function checkSlugAction(
  input: unknown,
): Promise<ActionResult<SlugAvailabilityDto>> {
  return run(async () => {
    const client = await createServerSupabaseClient();

    if ((await getSessionState(client)).status === "unauthenticated") {
      throw new AppException("unauthenticated");
    }

    const parsed = checkSlugSchema.safeParse(input);

    if (!parsed.success) {
      throw validationException(parsed.error);
    }

    return checkSlugAvailability(client, parsed.data.slug);
  });
}

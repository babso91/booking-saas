"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import { domainConfig } from "@/features/domains-server/config";
import { normalizeHostname } from "@/features/domains-server/hostname";
import {
  checkDomain,
  httpsProbe,
  systemResolver,
} from "@/features/domains-server/verifier";
import { AppException } from "@/lib/errors";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Her own domain (docs/SITE_DOMAIN_CONTRACT.md): the SiteDomainActions of the
// screen, owner only. Nothing is bought, no DNS written, no certificate
// requested from here.

type Dto = Record<string, unknown>;

async function slugOf(client: AppSupabaseClient, businessId: string) {
  const { data, error } = await client
    .from("businesses")
    .select("slug")
    .eq("id", businessId)
    .single();
  if (error) throw databaseException(error);
  return data.slug as string;
}

async function rpc(client: AppSupabaseClient, fn: string, args: object) {
  const { data, error } = await (
    client.rpc as unknown as (
      f: string,
      a: object,
    ) => Promise<{
      data: unknown;
      error: Parameters<typeof databaseException>[0] | null;
    }>
  )(fn, args);
  if (error) throw databaseException(error);
  return data as Dto | null;
}

const requestSchema = z.object({
  hostname: z.string().max(300),
  requestId: z.uuid(),
});
const generationSchema = z.object({
  id: z.uuid(),
  expectedGeneration: z.number().int().min(1),
  requestId: z.uuid(),
});

export async function readDomainAction() {
  return runBusinessAction(
    z.undefined(),
    undefined,
    async ({ client, businessId }) => {
      const config = domainConfig(await slugOf(client, businessId));
      return rpc(client, "site_domain_read", {
        p_business_id: businessId,
        p_target: config.target,
        p_fallback: config.fallback,
      });
    },
  );
}

/** A new challenge; `domain_taken` when another site holds the name. */
export async function requestDomainAction(input: unknown) {
  const result = await runBusinessAction(
    requestSchema,
    input,
    async ({ client, businessId }, data) => {
      const hostname = normalizeHostname(data.hostname);
      if (!hostname) {
        throw new AppException("validation_error", {
          fieldErrors: { hostname: ["Nom de domaine invalide."] },
        });
      }
      const config = domainConfig(await slugOf(client, businessId));
      return rpc(client, "site_domain_request", {
        p_business_id: businessId,
        p_hostname: hostname,
        p_request_id: data.requestId,
        p_target: config.target,
        p_fallback: config.fallback,
      });
    },
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

/**
 * Checks now (DNS read by the server, then our HTTPS probe). An expired
 * proof gets a new challenge: `proof_expired`, read again for the new value.
 * Checks are safe to repeat: `requestId` is accepted, not replayed.
 */
export async function retryDomainAction(input: unknown) {
  return runBusinessAction(
    generationSchema,
    input,
    async ({ client, businessId }, data) => {
      const config = domainConfig(await slugOf(client, businessId));
      const begun = (await rpc(client, "site_domain_begin_check", {
        p_business_id: businessId,
        p_domain_id: data.id,
        p_expected_generation: data.expectedGeneration,
        p_target: config.target,
        p_fallback: config.fallback,
      })) as {
        proofExpired?: boolean;
        id: string;
        hostname: string;
        generation: number;
        state: string;
        challenge: string;
      };
      if (begun.proofExpired) throw new AppException("proof_expired");
      await checkDomain(
        {
          service: createAdminSupabaseClient() as AppSupabaseClient,
          resolver: systemResolver,
          probe: httpsProbe,
          target: config.target,
        },
        begun,
      );
      return rpc(client, "site_domain_read", {
        p_business_id: businessId,
        p_target: config.target,
        p_fallback: config.fallback,
      });
    },
  );
}

/** Unlinks; her usual address goes on. */
export async function detachDomainAction(input: unknown) {
  const result = await runBusinessAction(
    generationSchema,
    input,
    async ({ client, businessId }, data) => {
      await rpc(client, "site_domain_detach", {
        p_business_id: businessId,
        p_domain_id: data.id,
        p_expected_generation: data.expectedGeneration,
        p_request_id: data.requestId,
      });
      return null;
    },
  );
  if (result.ok) revalidatePath("/app", "layout");
  return result;
}

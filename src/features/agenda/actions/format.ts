"use server";

import { z } from "zod";
import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import { hasSignatureAgenda } from "../data/format-access";
import { agendaFormats, agendaPreferenceKey } from "../formats";

const inputSchema = z
  .object({ membershipId: z.uuid(), format: z.enum(agendaFormats) })
  .strict();

export async function saveAgendaFormatAction(input: unknown) {
  return runBusinessAction(
    inputSchema,
    input,
    async ({ client, userId, businessId }, { membershipId, format }) => {
      const [membership, signature] = await Promise.all([
        client
          .from("business_members")
          .select("id")
          .eq("business_id", businessId)
          .eq("user_id", userId)
          .eq("id", membershipId)
          .maybeSingle(),
        hasSignatureAgenda(client, businessId),
      ]);
      if (membership.error) throw databaseException(membership.error);
      if (!membership.data) throw new AppException("context_changed");
      if (!signature) throw new AppException("forbidden");
      // Only a presentation preference. Auth merges this top-level metadata key,
      // so edits keep the other memberships and account settings intact.
      const { error } = await client.auth.updateUser({
        data: { [agendaPreferenceKey(membershipId)]: format },
      });
      if (error) throw new AppException("internal", { cause: error });
      return format;
    },
  );
}

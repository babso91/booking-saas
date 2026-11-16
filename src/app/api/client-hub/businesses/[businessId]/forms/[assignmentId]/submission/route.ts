import type { NextRequest } from "next/server";

import { hubSubmit } from "@/features/client-forms/data/forms";
import {
  assignmentIdSchema,
  submissionSchema,
} from "@/features/client-forms/schemas";
import {
  assertSameOrigin,
  withClientHubSession,
} from "@/features/client-hub/data/route";
import { businessIdSchema } from "@/features/client-hub/schemas/client-hub";
import { AppException, validationException } from "@/lib/errors";
import { readJsonBody } from "@/lib/http";

// POST /api/client-hub/businesses/:businessId/forms/:assignmentId/submission
// { templateVersionId, requestId, answers[] } → { receiptId, status, submittedAt }.
// Same origin and JSON only, like every state-changing Hub request.
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/client-hub/businesses/[businessId]/forms/[assignmentId]/submission">,
) {
  return withClientHubSession(request, async (admin, token) => {
    assertSameOrigin(request, true);
    const params = await ctx.params;
    const businessId = businessIdSchema.safeParse(params.businessId);
    const assignmentId = assignmentIdSchema.safeParse(params.assignmentId);
    if (!businessId.success || !assignmentId.success) {
      throw new AppException("client_hub_not_found");
    }
    const parsed = submissionSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw validationException(parsed.error);
    return hubSubmit(
      admin,
      token,
      businessId.data,
      assignmentId.data,
      parsed.data,
    );
  });
}

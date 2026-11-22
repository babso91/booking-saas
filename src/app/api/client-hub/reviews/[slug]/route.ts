import { z } from "zod";
import { businessSlugSchema } from "@/features/businesses/schemas/slug";
import {
  assertSameOrigin,
  withClientHubSession,
} from "@/features/client-hub/data/route";
import { AppException, validationException } from "@/lib/errors";
import { readJsonBody } from "@/lib/http";
import { databaseException } from "@/lib/supabase/errors";

type Context = RouteContext<"/api/client-hub/reviews/[slug]">;
const review = z
  .object({
    stars: z.number().int().min(1).max(5),
    comment: z.string().trim().max(500),
  })
  .strict();

async function handle(request: Request, ctx: Context, write: boolean) {
  return withClientHubSession(request, async (client, token, accountId) => {
    const slug = businessSlugSchema.safeParse((await ctx.params).slug);
    if (!slug.success) throw new AppException("business_not_found");
    const args: {
      p_slug: string;
      p_session_token: string;
      p_stars?: number;
      p_comment?: string;
    } = { p_slug: slug.data, p_session_token: token };
    if (write) {
      assertSameOrigin(request, true);
      if (request.headers.get("X-Client-Hub-Account") !== accountId)
        throw new AppException("conflict");
      const parsed = review.safeParse(await readJsonBody(request));
      if (!parsed.success) throw validationException(parsed.error);
      args.p_stars = parsed.data.stars;
      args.p_comment = parsed.data.comment;
    }
    const { data, error } = await client.rpc(
      "client_hub_business_review",
      args,
    );
    if (error) throw databaseException(error);
    return data;
  });
}

export const GET = (request: Request, ctx: Context) =>
  handle(request, ctx, false);
export const POST = (request: Request, ctx: Context) =>
  handle(request, ctx, true);

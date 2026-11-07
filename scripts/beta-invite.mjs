// Creates a private-beta invitation and PRINTS its link (docs/BETA_ACCESS.md).
// Nothing is sent: the operator gives the link to the invited professional.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… APP_URL=https://… \
//     node scripts/beta-invite.mjs camille@example.com [--days 7] [--note "…"]
//
// It runs with the service role, from an operator's machine: there is no
// endpoint, public or private, that creates an invitation. The token is
// shown once and only its SHA-256 is stored.

import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

import { createClient } from "@supabase/supabase-js";

// Same as src/features/beta/token.ts (tested together).
export function generateInvitationToken() {
  return `inv_${randomBytes(32).toString("base64url")}`;
}

export function hashInvitationToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Creates the invitation; answers its id, link and expiry. `client` is a
 * service-role Supabase client.
 */
export async function createBetaInvitation(
  client,
  { email, days, note, appUrl },
) {
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw new Error("--days must be a whole number from 1 to 30.");
  }
  const token = generateInvitationToken();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const { data, error } = await client.rpc("create_beta_invitation", {
    p_email: email,
    p_token_hash: hashInvitationToken(token),
    p_expires_at: expiresAt.toISOString(),
    p_note: note ?? null,
  });
  if (error) throw new Error(`Invitation refused: ${error.message}`);
  const url = new URL("/signup", appUrl);
  url.searchParams.set("invitation", token);
  return { id: data, url: url.toString(), expiresAt: expiresAt.toISOString() };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      days: { type: "string", default: "7" },
      note: { type: "string" },
    },
  });
  const email = positionals[0];
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL } = process.env;
  if (!email || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !APP_URL) {
    console.error(
      "Usage: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… APP_URL=… node scripts/beta-invite.mjs <email> [--days 7] [--note …]",
    );
    process.exit(2);
  }
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const invitation = await createBetaInvitation(client, {
    email,
    days: Number(values.days),
    note: values.note,
    appUrl: APP_URL,
  });
  // The link is the secret: shown once, to the operator only.
  console.log(`Invitation ${invitation.id} for ${email.trim().toLowerCase()}`);
  console.log(`Valid until ${invitation.expiresAt}`);
  console.log(
    `Link (give it to her yourself; nothing was sent):\n${invitation.url}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

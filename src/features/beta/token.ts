import { createHash, randomBytes } from "node:crypto";

// Beta invitation tokens (docs/BETA_ACCESS.md). 32 random bytes, base64url,
// prefixed so a token is recognisable in a link. Only their SHA-256 (hex) is
// stored. scripts/beta-invite.mjs makes them the same way (tested).

export const INVITATION_TOKEN_PATTERN = /^inv_[A-Za-z0-9_-]{43}$/;

export function generateInvitationToken(): string {
  return `inv_${randomBytes(32).toString("base64url")}`;
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

// Authenticated encryption of server secrets (OAuth tokens, PKCE verifiers)
// before they are stored: AES-256-GCM, random 96-bit IV, and associated data
// binding a ciphertext to its owner (a ciphertext copied to another business
// or another OAuth state does not decrypt). The key lives only in the server
// environment; the database stores ciphertext.
//
// Format: v1.<key id>.<iv>.<tag>.<ciphertext> (base64url). The key id (first
// 8 bytes of SHA-256 of the key, hex) selects the decryption key, so a
// rotation adds the new key as current and keeps former keys for decryption
// until every secret was rewritten (tokens are rewritten at each refresh).

export type SecretKey = { id: string; key: Buffer };

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

export function secretKey(base64: string): SecretKey {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) {
    throw new SecretBoxError("Encryption keys must be 32 bytes.");
  }
  return {
    id: createHash("sha256").update(key).digest("hex").slice(0, 16),
    key,
  };
}

export function encryptSecret(
  plaintext: string,
  associatedData: string,
  key: SecretKey,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    key.id,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(
  box: string,
  associatedData: string,
  keys: SecretKey[],
): string {
  const [version, keyId, iv, tag, ciphertext, ...rest] = box.split(".");
  if (
    version !== "v1" ||
    !keyId ||
    !iv ||
    !tag ||
    ciphertext === undefined ||
    rest.length > 0
  ) {
    throw new SecretBoxError("Unsupported secret format.");
  }
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) {
    throw new SecretBoxError("Unknown encryption key.");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key.key,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SecretBoxError("Secret could not be decrypted.");
  }
}

/** Hex SHA-256: stored instead of a secret that only needs comparing. */
export function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Cryptographically random URL-safe string (`bytes` bytes of entropy). */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

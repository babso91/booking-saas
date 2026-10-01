import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  randomToken,
  secretKey,
  sha256Hex,
} from "./secret-box";

const key = () => secretKey(randomBytes(32).toString("base64"));

describe("secret box (AES-256-GCM)", () => {
  it("round-trips and never stores the plaintext", () => {
    const current = key();
    const box = encryptSecret(
      "1//refresh-token",
      "calendar-token:google:b1",
      current,
    );
    expect(box).toMatch(/^v1\.[0-9a-f]{16}\./);
    expect(box).not.toContain("refresh-token");
    expect(decryptSecret(box, "calendar-token:google:b1", [current])).toBe(
      "1//refresh-token",
    );
    // Random IV: two encryptions differ.
    expect(encryptSecret("x", "a", current)).not.toBe(
      encryptSecret("x", "a", current),
    );
  });

  it("refuses another owner's ciphertext (associated data)", () => {
    const current = key();
    const box = encryptSecret("secret", "calendar-token:google:b1", current);
    expect(() =>
      decryptSecret(box, "calendar-token:google:b2", [current]),
    ).toThrow("Secret could not be decrypted.");
  });

  it("refuses a tampered ciphertext or tag", () => {
    const current = key();
    const parts = encryptSecret("secret", "aad", current).split(".");
    const flip = (value: string) =>
      Buffer.from(
        Buffer.from(value, "base64url").map((byte, i) =>
          i === 0 ? byte ^ 1 : byte,
        ),
      ).toString("base64url");
    for (const index of [2, 3, 4]) {
      const tampered = [...parts];
      tampered[index] = flip(tampered[index]!);
      expect(() =>
        decryptSecret(tampered.join("."), "aad", [current]),
      ).toThrow();
    }
  });

  it("decrypts with a former key during a rotation, not with an unknown one", () => {
    const former = key();
    const next = key();
    const box = encryptSecret("secret", "aad", former);
    expect(decryptSecret(box, "aad", [next, former])).toBe("secret");
    expect(() => decryptSecret(box, "aad", [next])).toThrow(
      "Unknown encryption key.",
    );
    expect(() => secretKey(randomBytes(16).toString("base64"))).toThrow();
  });

  it("hashes and generates tokens", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
  });
});

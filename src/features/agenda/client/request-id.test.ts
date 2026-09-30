import { describe, expect, it } from "vitest";

import { fingerprintOf, requestKeyFor } from "./request-id";

describe("creation idempotency key", () => {
  it("keeps the key for the same command (retry, double submit)", () => {
    let count = 0;
    const make = () => `id-${++count}`;
    const first = requestKeyFor(null, fingerprintOf({ a: 1, b: "x" }), make);
    const retry = requestKeyFor(first, fingerprintOf({ b: "x", a: 1 }), make);
    expect(retry).toBe(first);
    expect(count).toBe(1);
  });

  it("issues a new key as soon as the command changes", () => {
    const first = requestKeyFor(
      null,
      fingerprintOf({ time: "10:00" }),
      () => "id-1",
    );
    const changed = requestKeyFor(
      first,
      fingerprintOf({ time: "10:15" }),
      () => "id-2",
    );
    expect(changed.id).toBe("id-2");
  });

  it("ignores undefined fields in the fingerprint", () => {
    expect(fingerprintOf({ a: 1, occurrence: undefined })).toBe(
      fingerprintOf({ a: 1 }),
    );
    expect(
      fingerprintOf({ client: { lastName: undefined, firstName: "Léa" } }),
    ).toBe(fingerprintOf({ client: { firstName: "Léa" } }));
  });
});

import { describe, expect, it } from "vitest";

import {
  createServiceSchema,
  setServiceActiveSchema,
  updateServiceSchema,
} from "./service";

const SERVICE = "30000000-0000-4000-8000-000000000001";
const REQUEST = "40000000-0000-4000-8000-000000000001";

describe("createServiceSchema", () => {
  it("requires one request id (UUID) per creation", () => {
    const command = { name: "Pose", durationMinutes: 60, priceCents: 5000 };
    expect(createServiceSchema.safeParse(command).success).toBe(false);
    expect(
      createServiceSchema.safeParse({ ...command, requestId: "retry-1" })
        .success,
    ).toBe(false);
    expect(
      createServiceSchema.parse({ ...command, requestId: REQUEST }),
    ).toEqual({
      ...command,
      description: null,
      active: true,
      requestId: REQUEST,
    });
  });
});

describe("updateServiceSchema", () => {
  it("requires the version the edit is based on", () => {
    const edit = { serviceId: SERVICE, changes: { priceCents: 7000 } };
    expect(updateServiceSchema.safeParse(edit).success).toBe(false);
    for (const expectedVersion of [0, 1.5, -1, "1", 2_147_483_648]) {
      expect(
        updateServiceSchema.safeParse({ ...edit, expectedVersion }).success,
      ).toBe(false);
    }
    expect(updateServiceSchema.parse({ ...edit, expectedVersion: 3 })).toEqual({
      ...edit,
      expectedVersion: 3,
    });
  });
});

describe("setServiceActiveSchema", () => {
  it("takes a version optionally (by value otherwise)", () => {
    expect(
      setServiceActiveSchema.parse({ serviceId: SERVICE, active: false }),
    ).toEqual({ serviceId: SERVICE, active: false });
    expect(
      setServiceActiveSchema.parse({
        serviceId: SERVICE,
        active: false,
        expectedVersion: 2,
      }),
    ).toEqual({ serviceId: SERVICE, active: false, expectedVersion: 2 });
  });
});

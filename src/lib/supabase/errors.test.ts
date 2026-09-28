import { describe, expect, it } from "vitest";

import { toAppError } from "@/lib/errors";

import { databaseErrorCode, databaseException } from "./errors";

describe("databaseErrorCode", () => {
  it("maps domain errors raised by our SQL functions", () => {
    expect(
      databaseErrorCode({ code: "P0001", message: "slot_unavailable" }),
    ).toBe("slot_unavailable");
    expect(
      databaseErrorCode({ code: "P0002", message: "service_not_found" }),
    ).toBe("service_not_found");
    expect(databaseErrorCode({ code: "22023", message: "invalid_email" })).toBe(
      "validation_error",
    );
    expect(
      databaseErrorCode({ code: "P0001", message: "schedule_conflict" }),
    ).toBe("schedule_conflict");
  });

  it("maps constraint and RLS SQLSTATEs", () => {
    expect(
      databaseErrorCode({ code: "42501", message: "new row violates RLS" }),
    ).toBe("forbidden");
    expect(databaseErrorCode({ code: "23P01", message: "exclusion" })).toBe(
      "conflict",
    );
    expect(databaseErrorCode({ code: "23514", message: "check" })).toBe(
      "validation_error",
    );
  });

  it("hides anything unknown behind `internal`", () => {
    const error = databaseException({
      code: "XX000",
      message: "relation secret_table …",
    });

    expect(error.code).toBe("internal");
    expect(toAppError(error)).toEqual({
      code: "internal",
      message: "Une erreur inattendue est survenue. Merci de réessayer.",
    });
  });

  it("supports per-call overrides", () => {
    expect(
      databaseException(
        { code: "23503", message: "fk" },
        { conflict: "in_use" },
      ).code,
    ).toBe("in_use");
  });
});

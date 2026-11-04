import { describe, expect, it } from "vitest";

import { optionChoiceIdsSchema, setServiceOptionsSchema } from "./schemas";

const ID = "6f1c1d1e-4a39-4b4f-9a49-1f6b1c4f1a01";
const base = {
  serviceId: "6f1c1d1e-4a39-4b4f-9a49-1f6b1c4f1a02",
  expectedVersion: 3,
  options: [],
};

describe("setServiceOptionsSchema", () => {
  it("deletes nothing unless told: no deletion by default", () => {
    expect(setServiceOptionsSchema.parse(base)).toMatchObject({
      deletedOptionIds: [],
      deletedChoiceIds: [],
    });
  });

  it("refuses an id given twice, whatever its case", () => {
    for (const field of ["deletedOptionIds", "deletedChoiceIds"]) {
      expect(
        setServiceOptionsSchema.safeParse({
          ...base,
          [field]: [ID, ID.toUpperCase()],
        }).success,
      ).toBe(false);
    }
  });
});

describe("optionChoiceIdsSchema", () => {
  it("refuses an answer given twice, whatever its case", () => {
    expect(
      optionChoiceIdsSchema.safeParse([ID, ID.toUpperCase()]).success,
    ).toBe(false);
    expect(optionChoiceIdsSchema.safeParse([ID]).success).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { appErrorMessages } from "@/lib/errors";

import { describeError, errorCopy } from "./error-copy";

describe("errorCopy", () => {
  it("covers every backend error code plus network", () => {
    expect(Object.keys(errorCopy).sort()).toEqual(
      [...Object.keys(appErrorMessages), "network"].sort(),
    );
  });

  it("stays short, human and free of technical terms", () => {
    for (const code of Object.keys(errorCopy) as (keyof typeof errorCopy)[]) {
      const { title, message } = describeError({ code });
      expect(title.length).toBeGreaterThan(0);
      expect(message.length).toBeLessThan(140);
      expect(`${title} ${message}`).not.toMatch(
        /sql|supabase|postgres|error|exception/i,
      );
    }
  });

  it("does not confirm that an email is registered", () => {
    expect(describeError({ code: "email_taken" }).message).not.toMatch(
      /existe déjà|déjà utilisée/,
    );
  });
});

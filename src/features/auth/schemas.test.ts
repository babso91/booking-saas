import { describe, expect, it } from "vitest";

import {
  firstFieldErrors,
  passwordStrength,
  signInSchema,
  signUpSchema,
} from "./schemas";

describe("auth schemas", () => {
  it("trims the email and reports one message per field", () => {
    expect(
      signInSchema.parse({ email: " mila@studio.fr ", password: "x" }).email,
    ).toBe("mila@studio.fr");

    const result = signUpSchema.safeParse({
      email: "mila@",
      password: "court",
    });
    expect(result.success).toBe(false);
    expect(firstFieldErrors(result.error!)).toEqual({
      email: "Cet email semble incomplet.",
      password: "Au moins 10 caractères.",
    });
  });

  it("asks for an empty email instead of calling it invalid", () => {
    const result = signInSchema.safeParse({ email: "", password: "" });
    expect(firstFieldErrors(result.error!)).toEqual({
      email: "Indique ton email.",
      password: "Indique ton mot de passe.",
    });
  });
});

describe("passwordStrength", () => {
  it("grows with length and variety", () => {
    expect(passwordStrength("motdepass")).toBe(0);
    expect(passwordStrength("motdepasse")).toBe(1);
    expect(passwordStrength("MotDePasse2026!")).toBe(3);
  });
});

import { describe, expect, it } from "vitest";

import { formatPrice } from "./money";

const normalize = (value: string) => value.replace(/\s/g, " ");

describe("formatPrice", () => {
  it("formats minor units exactly, without floating point", () => {
    expect(normalize(formatPrice(6500, "EUR"))).toBe("65,00 €");
    expect(normalize(formatPrice(1999, "EUR"))).toBe("19,99 €");
    expect(normalize(formatPrice(5, "EUR"))).toBe("0,05 €");
    expect(normalize(formatPrice(123456789, "EUR"))).toBe("1 234 567,89 €");
  });

  it("respects the currency's minor digits", () => {
    // No minor unit: 1500 is ¥1,500, not ¥15.00.
    expect(normalize(formatPrice(1500, "JPY"))).toMatch(/^1 500/);
    expect(formatPrice(1500, "JPY")).not.toContain(",");
  });
});

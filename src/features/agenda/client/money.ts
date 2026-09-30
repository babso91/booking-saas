/**
 * Formats a price in minor units (`priceCents`) without any floating-point
 * arithmetic: the decimal string is built from integers and handed to
 * Intl.NumberFormat, which formats decimal strings exactly.
 */
export function formatPrice(cents: number, currency: string, locale = "fr-FR") {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  const sign = cents < 0 ? "-" : "";
  const units = String(Math.abs(Math.trunc(cents))).padStart(digits + 1, "0");
  const decimal =
    digits > 0
      ? `${sign}${units.slice(0, -digits)}.${units.slice(-digits)}`
      : `${sign}${units}`;

  return format.format(decimal as unknown as number);
}

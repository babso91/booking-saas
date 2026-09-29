// Joins class names, skipping falsy values. Enough for our needs without a
// dependency; components avoid conflicting utilities by construction.
export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

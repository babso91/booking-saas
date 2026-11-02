import type { Route } from "next";

// The rooms of the professional area, shared by every style's frame: same
// rooms, same addresses, same words.

export type DashboardSection =
  | "today"
  | "agenda"
  | "clients"
  | "services"
  | "loyalty"
  | "hours"
  | "calendar"
  | "appearance";

export const sectionHref: Record<DashboardSection, Route> = {
  today: "/app/today",
  agenda: "/app",
  clients: "/app/clients",
  services: "/app/services",
  loyalty: "/app/loyalty",
  hours: "/app/settings/hours",
  calendar: "/app/settings/calendar",
  appearance: "/app/settings/appearance",
};

/** Two letters for her monogram: initials of the business's name. */
export function initialsOf(name: string) {
  const words = name
    .normalize("NFC")
    .split(/[\s\-–—'’.]+/)
    .filter((word) => /\p{L}/u.test(word));
  const letters =
    words.length >= 2
      ? [words[0]!, words[1]!].map((word) => [...word][0])
      : [...(words[0] ?? "")].slice(0, 2);
  return letters.join("").toUpperCase() || "·";
}

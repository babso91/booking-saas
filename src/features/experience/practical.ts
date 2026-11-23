import type { Practical } from "./engine/config";

// Her "Infos pratiques" (Higani point 5): what a client needs before she
// books or comes. Her words come from her site (her studio's "Infos"); her
// usual hours from her real schedule (get_public_business_hours), never
// typed twice, so they cannot contradict her slots; her cancellation
// policy from her business settings. Nothing is shown that she did not
// fill in: her phone and e-mail appear only when she wrote them here.

/** One range of her usual week, as get_public_business_hours reads it. */
export type UsualHours = {
  /** 0 Sunday … 6 Saturday (Postgres dow). */
  weekday: number;
  /** "09:00". */
  startsAt: string;
  endsAt: string;
};

/** An empty block: what a new site starts from in her studio. */
export const emptyPractical: Practical = {
  address: "",
  area: "",
  access: "",
  instructions: "",
  payment: "",
  accessibility: "",
  phone: "",
  email: "",
  showHours: true,
  lateness: "",
  noShow: "",
  companions: "",
};

export type PracticalItem =
  | { kind: "text"; label: string; text: string }
  | { kind: "address"; label: string; text: string }
  | { kind: "hours"; label: string; days: { day: string; ranges: string }[] }
  | {
      kind: "contact";
      label: string;
      phone: string | null;
      email: string | null;
      /** Shown only when it reads as an international number. */
      whatsapp: string | null;
    };

const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = [
  "Dimanche",
  "Lundi",
  "Mardi",
  "Mercredi",
  "Jeudi",
  "Vendredi",
  "Samedi",
];

/** "09:00" → "9 h", "12:30" → "12 h 30". */
export function hourLabel(time: string): string {
  const [hours = "0", minutes = "00"] = time.split(":");
  const h = String(Number(hours));
  return minutes === "00" ? `${h} h` : `${h} h ${minutes}`;
}

/** Her usual week, Monday first: each day with its ranges, or "Fermé". */
export function usualWeek(
  hours: readonly UsualHours[],
): { day: string; ranges: string }[] {
  return WEEK.map((weekday) => {
    const ranges = hours
      .filter((range) => range.weekday === weekday)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map(
        (range) => `${hourLabel(range.startsAt)} – ${hourLabel(range.endsAt)}`,
      );
    return {
      day: DAY_NAMES[weekday]!,
      ranges: ranges.length ? ranges.join(", ") : "Fermé",
    };
  });
}

/**
 * What her "Infos pratiques" shows, in the order a client needs it:
 * where, when, how to get in, what to bring, how to pay, access, her
 * conditions (cancellation, lateness, a missed visit, companions), how to
 * reach her. Empty when there is nothing.
 */
export function practicalItems({
  practical,
  hours,
  cancellationPolicy,
}: {
  practical: Practical | undefined;
  hours: readonly UsualHours[] | null;
  cancellationPolicy: string | null;
}): PracticalItem[] {
  const items: PracticalItem[] = [];
  const text = (label: string, value: string | undefined | null) => {
    const trimmed = value?.trim();
    if (trimmed) items.push({ kind: "text", label, text: trimmed });
  };
  if (practical?.address.trim())
    items.push({
      kind: "address",
      label: "Adresse",
      text: practical.address.trim(),
    });
  text("Zone d’intervention", practical?.area);
  // Her hours appear once she has a site block, unless she hid them; a
  // schedule with no range at all says nothing useful.
  if (practical?.showHours && hours?.length)
    items.push({
      kind: "hours",
      label: "Horaires habituels",
      days: usualWeek(hours),
    });
  // Higani point 18: what a client needs first (where, when, how to reach
  // her), then how to come, then her conditions, each still on the page.
  const phone = practical?.phone.trim() || null;
  const email = practical?.email.trim() || null;
  const whatsapp = whatsappHref(practical?.whatsapp)
    ? practical!.whatsapp!.trim()
    : null;
  if (phone || email || whatsapp)
    items.push({ kind: "contact", label: "Contact", phone, email, whatsapp });
  text("Accès", practical?.access);
  text("Avant de venir", practical?.instructions);
  text("Paiement", practical?.payment);
  text("Accessibilité", practical?.accessibility);
  text("Annulation", cancellationPolicy);
  text("Retard", practical?.lateness);
  text("Rendez-vous manqué", practical?.noShow);
  text("Accompagnants", practical?.companions);
  return items;
}

/** A phone number as a tel: link (digits and a leading +). */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

/** A WhatsApp link for an international number (+33 6 …), else null. */
export function whatsappHref(number: string | undefined) {
  const digits = number?.replace(/[^\d+]/g, "") ?? "";
  return /^\+\d{8,15}$/.test(digits)
    ? `https://wa.me/${digits.slice(1)}`
    : null;
}

/** Directions to her address, opened only when a client asks for them. */
export function directionsHref(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

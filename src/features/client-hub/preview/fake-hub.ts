import type {
  ClientHubAppointmentDetailDto,
  ClientHubProfileDto,
  ClientHubSlotDto,
} from "@/features/client-hub/types";
import {
  addDays,
  businessToday,
} from "@/features/public-booking/client/business-time";

// A stand-in for the Client Hub routes, in the browser's memory, for the
// design preview only (/apercu/espace): fictional data, nothing read from
// or written to any server. It answers as the PROPOSED contract of her own
// changes describes (docs/CLIENT_HUB_ACTIONS_PROPOSAL.md), so the screens
// can be reviewed before those routes exist. Never imported by a real page.

export const PREVIEW_BUSINESS = "11111111-1111-4111-8111-111111111111";
export const PREVIEW_APPOINTMENT = "a1111111-1111-4111-8111-111111111111";
const ACCOUNT = "preview-account";
const ZONE = "Europe/Paris";

export type PreviewScenario =
  /** Both changes open, with a deadline. */
  | "ouvert"
  /** The deadline has passed: both closed, with the reason. */
  | "ferme"
  /** As today's server answers: no `actions` at all. */
  | "sans";

/** `YYYY-MM-DDTHH:MM` in Paris, as an instant (winter time: UTC+1). */
const instant = (local: string) => new Date(`${local}:00+01:00`).toISOString();

function slotsOf(date: string, taken: string | null): ClientHubSlotDto[] {
  // Every third day is full, to see the empty state.
  if (Number(date.slice(8, 10)) % 3 === 0) return [];
  return ["09:30", "11:00", "14:00", "15:30", "17:00"]
    .map((time) => ({
      startsAt: instant(`${date}T${time}`),
      endsAt: instant(`${date}T${time}`),
      localStartsAt: `${date}T${time}`,
      localEndsAt: `${date}T${time}`,
    }))
    .filter((slot) => slot.startsAt !== taken);
}

export function installFakeHub(scenario: PreviewScenario) {
  const today = businessToday(ZONE);
  const day = addDays(today, 5);
  const closed = (reason: "policy_cutoff_passed") => ({
    allowed: false,
    deadlineAt: null,
    reason,
  });
  const open = () => ({
    allowed: true,
    deadlineAt: instant(`${addDays(today, 4)}T14:00`),
    reason: null,
  });
  let version = 3;
  let appointment: ClientHubAppointmentDetailDto = {
    id: PREVIEW_APPOINTMENT,
    status: "confirmed",
    startsAt: instant(`${day}T14:00`),
    endsAt: instant(`${day}T15:30`),
    serviceName: "Rehaussement de cils",
    durationMinutes: 90,
    priceCents: 6500,
    currency: "EUR",
    business: {
      name: "Atelier Maëlys",
      slug: "atelier-maelys",
      timezone: ZONE,
      location: "12 rue des Lilas, Lyon 6e",
      cancellationPolicy:
        "Annulation et déplacement sans frais jusqu’à 24 h avant le rendez-vous.",
    },
    actions:
      scenario === "sans"
        ? undefined
        : scenario === "ferme"
          ? {
              version,
              cancel: closed("policy_cutoff_passed"),
              reschedule: closed("policy_cutoff_passed"),
            }
          : { version, cancel: open(), reschedule: open() },
  };
  const profile: ClientHubProfileDto = {
    email: "camille@exemple.fr",
    businesses: [
      {
        businessId: PREVIEW_BUSINESS,
        name: appointment.business.name,
        slug: appointment.business.slug,
        timezone: ZONE,
        location: appointment.business.location,
        customer: { firstName: "Camille", lastName: "Martin" },
      },
    ],
  };
  /** One slot is always "just taken", to see that refusal. */
  const contested = instant(`${addDays(today, 1)}T11:00`);

  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "x-client-hub-account": ACCOUNT,
      },
    });
  const ok = (data: unknown) => answer(200, { data });
  const fail = (code: string, status: number) =>
    answer(status, { error: { code } });

  const real = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url,
      window.location.origin,
    );
    if (!url.pathname.startsWith("/api/client-hub/")) return real(input, init);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const path = url.pathname.replace("/api/client-hub", "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as {
            expectedVersion?: number;
            startsAt?: string;
          })
        : {};
    const one = `/businesses/${PREVIEW_BUSINESS}/appointments/${PREVIEW_APPOINTMENT}`;

    if (path === "/me") return ok(profile);
    if (path === one && method === "GET") return ok(appointment);
    if (path === `${one}/reschedule-slots`)
      return ok({
        date: url.searchParams.get("date"),
        timezone: ZONE,
        slots: slotsOf(url.searchParams.get("date") ?? today, null),
      });
    if (
      method === "POST" &&
      (path === `${one}/cancel` || path === `${one}/reschedule`)
    ) {
      if (body.expectedVersion !== version)
        return fail("stale_appointment", 409);
      version += 1;
      if (path.endsWith("/cancel")) {
        appointment = { ...appointment, status: "cancelled", actions: null };
        return ok(appointment);
      }
      if (body.startsAt === contested) {
        version -= 1;
        return fail("slot_unavailable", 409);
      }
      const startsAt = body.startsAt ?? appointment.startsAt;
      appointment = {
        ...appointment,
        startsAt,
        endsAt: new Date(Date.parse(startsAt) + 90 * 60_000).toISOString(),
        actions: appointment.actions
          ? { ...appointment.actions, version }
          : appointment.actions,
      };
      return ok(appointment);
    }
    if (path.endsWith("/appointments"))
      return ok({ items: [appointment], nextCursor: null });
    return fail("client_hub_not_found", 404);
  };
  return () => {
    window.fetch = real;
  };
}

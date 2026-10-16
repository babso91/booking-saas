// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicBusiness, PublicService } from "../client/api";
import { addDays, businessToday, dayLabel } from "../client/business-time";
import { PublicBooking } from "./public-booking";

// The public booking page, from what a customer sees and does. Real
// components and flow; only the browser's fetch is replaced, answering with
// the public routes' real shapes (docs/PUBLIC_BOOKING_CONTRACT.md). This is
// not proof of persistence: tests/integration/public-booking-guarantees
// covers the routes against PostgreSQL.

const TZ = "America/Vancouver";
const SERVICE_A = "30000000-0000-4000-8000-000000000001";
const SERVICE_B = "30000000-0000-4000-8000-000000000002";

const business: PublicBusiness = {
  slug: "studio-mila",
  name: "Studio Mila",
  description: "Extensions de cils, sur rendez-vous.",
  location: "Vancouver, Main Street",
  logoPath: null,
  timezone: TZ,
  cancellationPolicy: null,
  currency: "EUR",
  slotIntervalMinutes: 15,
  minimumBookingNoticeMinutes: 120,
  maximumBookingAdvanceDays: 30,
};
const services: PublicService[] = [
  {
    id: SERVICE_A,
    name: "Pose cil à cil",
    description: "Effet naturel.",
    durationMinutes: 120,
    priceCents: 11000,
    currency: "EUR",
  },
  {
    id: SERVICE_B,
    name: "Rehaussement",
    description: null,
    durationMinutes: 75,
    priceCents: 6550,
    currency: "EUR",
  },
];

/** Wall clocks deliberately far from any UTC reading of `startsAt`. */
const slotsFor = (date: string) => [
  {
    startsAt: `${date}T16:30:00.000Z`,
    endsAt: `${date}T18:30:00.000Z`,
    localStartsAt: `${date}T09:30`,
    localEndsAt: `${date}T11:30`,
  },
  {
    startsAt: `${date}T21:00:00.000Z`,
    endsAt: `${date}T23:00:00.000Z`,
    localStartsAt: `${date}T14:00`,
    localEndsAt: `${date}T16:00`,
  },
];

const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
const ok = (data: unknown, status = 200) => json(status, { data });
const refuse = (
  status: number,
  code: string,
  fieldErrors?: Record<string, string[]>,
) => json(status, { error: { code, message: "backend text", fieldErrors } });
const lost = () => Promise.reject(new TypeError("Failed to fetch"));
const deferred = () => {
  let resolve!: (value: Response | PromiseLike<Response>) => void;
  const promise = new Promise<Response>((done) => (resolve = done));
  return { promise, resolve };
};

const api = {
  business: vi.fn<() => Promise<Response>>(),
  availability: vi.fn<(serviceId: string, date: string) => Promise<Response>>(),
  booking: vi.fn<(body: Record<string, unknown>) => Promise<Response>>(),
};
const bookingBodies = () =>
  api.booking.mock.calls.map(([body]) => body as Record<string, unknown>);

const today = businessToday(TZ);
const bookingFor = (overrides: Record<string, unknown> = {}) => ({
  appointmentId: "40000000-0000-4000-8000-000000000001",
  startsAt: `${today}T16:30:00.000Z`,
  endsAt: `${today}T18:30:00.000Z`,
  timezone: TZ,
  serviceName: "Pose cil à cil (au moment de la réservation)",
  durationMinutes: 120,
  priceCents: 11000,
  currency: "EUR",
  businessName: "Studio Mila",
  status: "confirmed",
  replayed: false,
  ...overrides,
});

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.availability.mockImplementation((_, date) =>
    ok({ date, timezone: TZ, slots: slotsFor(date) }),
  );
  api.business.mockImplementation(() => ok({ business, services }));
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/bookings") {
      return api.booking(JSON.parse(String(init?.body)));
    }
    if (url.pathname.endsWith("/availability")) {
      return api.availability(
        url.searchParams.get("serviceId")!,
        url.searchParams.get("date")!,
      );
    }
    return api.business();
  }) as unknown as typeof fetch;
});
afterEach(() => {
  vi.useRealTimers();
});

const renderPage = (list = services) =>
  render(<PublicBooking business={business} services={list} />);

const chooseService = async (name = "Pose cil à cil") => {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
  await screen.findByRole("heading", { name: "Choisissez un créneau" });
};
const slotButton = (time: string) =>
  screen.findByRole("button", { name: new RegExp(`à ${time}$`) });
const field = (label: RegExp) =>
  screen.getByLabelText(label) as HTMLInputElement;
const type = (label: RegExp, value: string) =>
  fireEvent.change(field(label), { target: { value } });
const fillContact = () => {
  type(/^Prénom/, "  Inès ");
  type(/^Email/, " Ines.Benali@Exemple.FR ");
};
const toReview = async () => {
  await chooseService();
  fireEvent.click(await slotButton("09:30"));
  await screen.findByRole("heading", { name: "Vos coordonnées" });
  fillContact();
  fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
  await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
};
const confirmButton = () =>
  screen.getByRole("button", { name: /Confirmer la réservation/ });
const flush = () => act(async () => {});

describe("the business and its services", () => {
  it("shows who the business is and its active services, with duration, price and description", () => {
    renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: "Studio Mila" }),
    ).toBeTruthy();
    expect(screen.getByText("Vancouver, Main Street")).toBeTruthy();
    const list = within(screen.getByRole("list", { name: "Prestations" }));
    expect(list.getAllByRole("button")).toHaveLength(2);
    expect(list.getByText(/2 h · 110,00\s€/)).toBeTruthy();
    expect(list.getByText(/1 h 15 · 65,50\s€/)).toBeTruthy();
    expect(list.getByText("Effet naturel.")).toBeTruthy();
  });

  it("no active service: says bookings are not open yet, nothing to pick", () => {
    renderPage([]);
    expect(screen.getByText("Aucune prestation en ligne")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Prestations" })).toBeNull();
  });
});

describe("days and slots", () => {
  it("lists the real slots of the business's today, as the business's wall clocks (never the device's)", async () => {
    renderPage();
    await chooseService();
    expect(api.availability).toHaveBeenCalledWith(SERVICE_A, today);
    // 16:30Z would read 18:30 in Paris or 16:30 in UTC: the business's
    // own wall clock is shown, as the backend gave it.
    expect((await slotButton("09:30")).textContent).toBe("09:30");
    expect((await slotButton("14:00")).textContent).toBe("14:00");
    expect(
      screen.getByText(/heure de Vancouver \(America\/Vancouver\)/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: dayLabel(today) })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("a day without slots says so and offers the next day", async () => {
    api.availability.mockImplementation((_, date) =>
      ok({
        date,
        timezone: TZ,
        slots: date === today ? [] : slotsFor(date),
      }),
    );
    renderPage();
    await chooseService();
    expect(
      await screen.findByText("Aucun créneau disponible ce jour-là."),
    ).toBeTruthy();
    const tomorrow = addDays(today, 1);
    fireEvent.click(
      screen.getByRole("button", { name: `Voir le ${dayLabel(tomorrow)}` }),
    );
    expect(await slotButton("09:30")).toBeTruthy();
    expect(api.availability).toHaveBeenLastCalledWith(SERVICE_A, tomorrow);
  });

  it("a later answer for an earlier day or service never replaces the latest choice", async () => {
    const first = deferred();
    const second = deferred();
    api.availability
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    renderPage();
    await chooseService();
    const tomorrow = addDays(today, 1);
    fireEvent.click(screen.getByRole("button", { name: dayLabel(tomorrow) }));
    // Tomorrow answers first, then today's late answer arrives.
    second.resolve(
      await ok({
        date: tomorrow,
        timezone: TZ,
        slots: [slotsFor(tomorrow)[1]],
      }),
    );
    expect(await slotButton("14:00")).toBeTruthy();
    first.resolve(
      await ok({ date: today, timezone: TZ, slots: slotsFor(today) }),
    );
    await flush();
    expect(screen.queryByRole("button", { name: /à 09:30$/ })).toBeNull();
    expect(
      screen.getByRole("list", { name: `Créneaux du ${dayLabel(tomorrow)}` }),
    ).toBeTruthy();

    // Another service: its slots are read for the chosen day.
    fireEvent.click(
      screen.getByRole("button", { name: "Changer de prestation" }),
    );
    await screen.findByRole("heading", { name: "Choisissez une prestation" });
    fireEvent.click(screen.getByRole("button", { name: /Rehaussement/ }));
    await waitFor(() =>
      expect(api.availability).toHaveBeenLastCalledWith(SERVICE_B, tomorrow),
    );
  });

  it("slots that cannot be read say so, with a retry", async () => {
    api.availability.mockImplementationOnce(lost);
    renderPage();
    await chooseService();
    expect(
      await screen.findByText("La connexion a été interrompue."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await slotButton("09:30")).toBeTruthy();
  });
});

describe("contact details", () => {
  it("only first name and email are required; mistakes are explained on their field, nothing is sent", async () => {
    renderPage();
    await chooseService();
    fireEvent.click(await slotButton("09:30"));
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    type(/^Email/, "ines@exemple");
    type(/^Téléphone/, "abc");
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    await flush();
    expect(screen.getByText("Indiquez votre prénom.")).toBeTruthy();
    expect(screen.getByText(/Adresse email invalide/)).toBeTruthy();
    expect(screen.getByText(/Numéro invalide/)).toBeTruthy();
    expect(field(/^Prénom/).getAttribute("aria-invalid")).toBe("true");
    expect(field(/^Prénom/).getAttribute("aria-describedby")).toBeTruthy();
    expect(field(/^Nom/).getAttribute("aria-invalid")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Vos coordonnées" }),
    ).toBeTruthy();
    expect(api.booking).not.toHaveBeenCalled();
  });
});

describe("booking", () => {
  it("sends exactly the reviewed booking once, then shows the backend's confirmation (no email promised)", async () => {
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor() }, 201),
    );
    renderPage();
    await toReview();
    expect(screen.getByText(/Inès · ines.benali@exemple.fr/)).toBeTruthy();
    fireEvent.click(confirmButton());
    expect(
      await screen.findByRole("heading", { name: "Rendez-vous confirmé" }),
    ).toBeTruthy();
    expect(bookingBodies()).toEqual([
      {
        slug: "studio-mila",
        serviceId: SERVICE_A,
        startsAt: `${today}T16:30:00.000Z`,
        firstName: "Inès",
        email: "ines.benali@exemple.fr",
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ]);
    // From the answer, not the form.
    expect(
      screen.getByText("Pose cil à cil (au moment de la réservation)"),
    ).toBeTruthy();
    expect(screen.getByText(/09:30 \(heure de Vancouver\)/)).toBeTruthy();
    expect(screen.getByText("Confirmé")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /email (de confirmation )?(a été )?envoy/i,
    );
    expect(document.body.textContent).not.toMatch(/rappel/i);
  });

  it("a replay is the same appointment, said as such; a later change of status is shown", async () => {
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor({ replayed: true }) }),
    );
    const view = renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    expect(
      await screen.findByText(
        /c’est le même rendez-vous, rien n’a été réservé en double/,
      ),
    ).toBeTruthy();
    view.unmount();

    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor({ replayed: true, status: "cancelled" }) }),
    );
    renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    expect(
      await screen.findByText("Cette réservation a changé depuis"),
    ).toBeTruthy();
    expect(screen.getByText("Annulé")).toBeTruthy();
  });

  it("a replay answering another time than the one sent does not show a time it cannot vouch for", async () => {
    api.booking.mockImplementationOnce(() =>
      ok({
        booking: bookingFor({
          replayed: true,
          startsAt: `${today}T19:00:00.000Z`,
        }),
      }),
    );
    renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    expect(
      await screen.findByText(/Modifiées depuis par l’établissement/),
    ).toBeTruthy();
    expect(screen.queryByText(/09:30 \(heure de/)).toBeNull();
  });

  it("while sending: one request whatever the clicks, nothing can be changed, no success before the answer", async () => {
    const answer = deferred();
    api.booking.mockImplementationOnce(() => answer.promise);
    renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    fireEvent.keyDown(confirmButton(), { key: "Enter" });
    fireEvent.click(confirmButton());
    await flush();
    expect(api.booking).toHaveBeenCalledTimes(1);
    expect(confirmButton().getAttribute("aria-busy")).toBe("true");
    expect(
      (
        screen.getByRole("button", {
          name: "Changer de créneau",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.queryByRole("heading", { name: "Rendez-vous confirmé" }),
    ).toBeNull();
    answer.resolve(await ok({ booking: bookingFor() }, 201));
    expect(
      await screen.findByRole("heading", { name: "Rendez-vous confirmé" }),
    ).toBeTruthy();
  });

  it("the confirmation's title receives focus (keyboard and screen readers follow the steps)", async () => {
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor() }, 201),
    );
    renderPage();
    await chooseService();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Choisissez un créneau" }),
    );
    fireEvent.click(await slotButton("09:30"));
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Vos coordonnées" }),
    );
    fillContact();
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
    fireEvent.click(confirmButton());
    const done = await screen.findByRole("heading", {
      name: "Rendez-vous confirmé",
    });
    expect(document.activeElement).toBe(done);
  });
});

describe("an answer that never arrives", () => {
  it("is said honestly, and retried with the same request id and the exact same body", async () => {
    api.booking.mockImplementationOnce(lost);
    renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    expect(await screen.findByText("Réservation non confirmée")).toBeTruthy();
    expect(
      screen.getByText(/votre rendez-vous a peut-être été enregistré/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Rendez-vous confirmé" }),
    ).toBeNull();

    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor({ replayed: true }) }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Renvoyer la même demande" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Rendez-vous confirmé" }),
    ).toBeTruthy();
    const [firstBody, secondBody] = bookingBodies();
    expect(secondBody).toEqual(firstBody);
  });

  it("an unexpected server error is treated the same way (it may have booked)", async () => {
    api.booking.mockImplementationOnce(() => refuse(500, "internal"));
    renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    expect(await screen.findByText("Réservation non confirmée")).toBeTruthy();
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor() }, 201),
    );
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    expect(bookingBodies()[1]).toEqual(bookingBodies()[0]);
  });

  it("survives leaving the page: offered back on return, and resent exactly", async () => {
    api.booking.mockImplementationOnce(lost);
    const view = renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    await screen.findByText("Réservation non confirmée");
    view.unmount();

    renderPage();
    expect(screen.getByText("Réservation non confirmée")).toBeTruthy();
    // Nothing else is shown to compare it with yet.
    expect(screen.queryByText(/Elle diffère/)).toBeNull();
    expect(
      screen.getByText(
        new RegExp(
          `Pose cil à cil, ${dayLabel(today)} à 09:30, au nom de Inès`,
        ),
      ),
    ).toBeTruthy();
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor({ replayed: true }) }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Renvoyer la même demande" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Rendez-vous confirmé" }),
    ).toBeTruthy();
    expect(bookingBodies()[1]).toEqual(bookingBodies()[0]);
    // Answered: nothing is offered back any more.
    expect(screen.queryByText("Réservation non confirmée")).toBeNull();
  });

  it("another business page never sees it", async () => {
    api.booking.mockImplementationOnce(lost);
    const view = renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    await screen.findByText("Réservation non confirmée");
    view.unmount();
    render(
      <PublicBooking
        business={{ ...business, slug: "atelier-nour", name: "Atelier Nour" }}
        services={services}
      />,
    );
    expect(screen.queryByText("Réservation non confirmée")).toBeNull();
  });

  it("a different booking waits until the unconfirmed one is resent or abandoned, then gets a new request id", async () => {
    api.booking.mockImplementationOnce(lost);
    renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    await screen.findByText("Réservation non confirmée");

    fireEvent.click(
      screen.getByRole("button", { name: "Modifier mes coordonnées" }),
    );
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    type(/^Téléphone/, "06 12 34 56 78");
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
    expect(
      screen.getByText(/Elle diffère de la réservation affichée/),
    ).toBeTruthy();
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirmButton());
    expect(api.booking).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "L’abandonner" }));
    await flush();
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor() }, 201),
    );
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    const [first, second] = bookingBodies();
    expect(second!.phone).toBe("06 12 34 56 78");
    expect(second!.requestId).not.toBe(first!.requestId);
  });
});

describe("refusals", () => {
  it("slot taken meanwhile: back to that day's slots, read again, details kept", async () => {
    api.booking.mockImplementationOnce(() => refuse(409, "slot_unavailable"));
    renderPage();
    await toReview();
    const readsBefore = api.availability.mock.calls.length;
    fireEvent.click(confirmButton());
    expect(
      await screen.findByText("Ce créneau n’est plus disponible"),
    ).toBeTruthy();
    expect(api.availability.mock.calls.length).toBe(readsBefore + 1);
    expect(api.availability).toHaveBeenLastCalledWith(SERVICE_A, today);

    fireEvent.click(await slotButton("14:00"));
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    expect(field(/^Prénom/).value).toBe("Inès");
    expect(field(/^Email/).value).toBe("ines.benali@exemple.fr");
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor() }, 201),
    );
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    const [first, second] = bookingBodies();
    expect(second!.startsAt).toBe(`${today}T21:00:00.000Z`);
    expect(second!.requestId).not.toBe(first!.requestId);
  });

  it("too many bookings: a neutral message, nothing retried by itself, details kept", async () => {
    api.booking.mockImplementationOnce(() => refuse(429, "rate_limited"));
    renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    expect(
      await screen.findByText("Trop de demandes pour le moment"),
    ).toBeTruthy();
    await act(() => new Promise((done) => setTimeout(done, 50)));
    expect(api.booking).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Inès · ines.benali@exemple.fr/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /email (est )?(déjà )?(connu|utilisé)/i,
    );

    // Later, on purpose: the same content keeps its request id.
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor() }, 201),
    );
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    expect(bookingBodies()[1]).toEqual(bookingBodies()[0]);
  });

  it("idempotency_conflict: explained, never resent with a new id by itself; a new request is an explicit choice", async () => {
    api.booking.mockImplementationOnce(() =>
      refuse(409, "idempotency_conflict"),
    );
    renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    expect(await screen.findByText("Demande déjà utilisée")).toBeTruthy();
    await flush();
    expect(api.booking).toHaveBeenCalledTimes(1);

    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor() }, 201),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Envoyer comme nouvelle demande" }),
    );
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    const [first, second] = bookingBodies();
    expect(second!.requestId).not.toBe(first!.requestId);
    expect({ ...second, requestId: null }).toEqual({
      ...first,
      requestId: null,
    });
  });

  it("refused details come back to their field", async () => {
    api.booking.mockImplementationOnce(() =>
      refuse(400, "validation_error", { email: ["x"] }),
    );
    renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    expect(screen.getByText(/Adresse email invalide/)).toBeTruthy();
    expect(screen.queryByText("backend text")).toBeNull();
    expect(field(/^Prénom/).value).toBe("Inès");
  });

  it("service no longer offered: back to the services, read again from the public route", async () => {
    api.booking.mockImplementationOnce(() => refuse(404, "service_not_found"));
    api.business.mockImplementationOnce(() =>
      ok({ business, services: [services[1]] }),
    );
    renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    expect(await screen.findByText("Prestation plus proposée")).toBeTruthy();
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Prestations" })).getAllByRole(
          "button",
        ),
      ).toHaveLength(1),
    );
    expect(api.business).toHaveBeenCalledTimes(1);
  });

  it("business no longer bookable: said plainly", async () => {
    api.booking.mockImplementationOnce(() => refuse(404, "business_not_found"));
    renderPage();
    await toReview();
    fireEvent.click(confirmButton());
    expect(await screen.findByText("Réservation indisponible")).toBeTruthy();
  });
});

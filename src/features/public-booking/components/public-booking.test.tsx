// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  cleanup,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicCatalog } from "@/features/catalog/model";

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
  // The server answers the business-local date; the test uses the same one.
  today: businessToday(TZ),
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

/** Her catalogue as the server projects it: these services, no category. */
const catalogOf = (list: PublicService[]): PublicCatalog => ({
  currency: "EUR",
  groups:
    list.length === 0
      ? []
      : [
          {
            category: null,
            services: list.map((item) => ({
              id: item.id,
              name: item.name,
              description: item.description,
              durationMinutes: item.durationMinutes,
              priceCents: item.priceCents,
              options: [],
            })),
          },
        ],
});

/** The server's quote for a service without answers: its own values. */
const quoteOf = (serviceId: string) => {
  const item = services.find((entry) => entry.id === serviceId)!;
  return {
    serviceName: item.name,
    durationMinutes: item.durationMinutes,
    priceCents: item.priceCents,
    currency: "EUR",
    options: [],
  };
};

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
  availability:
    vi.fn<
      (serviceId: string, date: string, choices?: string) => Promise<Response>
    >(),
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
  api.availability.mockImplementation((serviceId, date) =>
    ok({
      date,
      timezone: TZ,
      slots: slotsFor(date),
      quote: quoteOf(serviceId),
    }),
  );
  api.business.mockImplementation(() =>
    ok({ business, services, catalog: catalogOf(services) }),
  );
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/bookings") {
      return api.booking(JSON.parse(String(init?.body)));
    }
    if (url.pathname.endsWith("/availability")) {
      const choices = url.searchParams.get("optionChoiceIds");
      // Answers only when there are some: the call is the one of before.
      return choices === null
        ? api.availability(
            url.searchParams.get("serviceId")!,
            url.searchParams.get("date")!,
          )
        : api.availability(
            url.searchParams.get("serviceId")!,
            url.searchParams.get("date")!,
            choices,
          );
    }
    return api.business();
  }) as unknown as typeof fetch;
});
afterEach(() => {
  vi.useRealTimers();
});

const renderPage = (list = services) =>
  render(<PublicBooking business={business} catalog={catalogOf(list)} />);

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

describe("from her mini-site", () => {
  it("a service tapped there opens on its required options, never straight on slots", async () => {
    const catalog = catalogOf(services);
    catalog.groups[0]!.services[0]!.options = [
      {
        id: "40000000-0000-4000-8000-000000000001",
        question: "Longueur",
        required: true,
        choices: [
          {
            id: "50000000-0000-4000-8000-000000000001",
            label: "Naturel",
            priceDeltaCents: 0,
            durationDeltaMinutes: 0,
          },
          {
            id: "50000000-0000-4000-8000-000000000002",
            label: "Volume",
            priceDeltaCents: 1500,
            durationDeltaMinutes: 20,
          },
        ],
      },
    ];
    render(
      <PublicBooking
        business={business}
        catalog={catalog}
        embedded
        initialServiceId={SERVICE_A}
      />,
    );
    await flush();
    // Her site already says who she is: the steps only.
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(
      screen.getByRole("heading", { name: /Personnalisez votre prestation/ }),
    ).toBeTruthy();
    expect(screen.getByText("Longueur")).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Choisissez un créneau" }),
    ).toBeNull();
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
        .getByRole("button", { name: new RegExp(`, ${dayLabel(today)}$`) })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("a day without slots says so and offers the next day", async () => {
    api.availability.mockImplementation((_, date) =>
      ok({
        date,
        timezone: TZ,
        slots: date === today ? [] : slotsFor(date),
        quote: quoteOf(SERVICE_A),
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
    fireEvent.click(
      screen.getByRole("button", {
        name: new RegExp(`, ${dayLabel(tomorrow)}$`),
      }),
    );
    // Tomorrow answers first, then today's late answer arrives.
    second.resolve(
      await ok({
        date: tomorrow,
        timezone: TZ,
        slots: [slotsFor(tomorrow)[1]],
        quote: quoteOf(SERVICE_A),
      }),
    );
    expect(await slotButton("14:00")).toBeTruthy();
    first.resolve(
      await ok({
        date: today,
        timezone: TZ,
        slots: slotsFor(today),
        quote: quoteOf(SERVICE_A),
      }),
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
        // What she accepted, sent even without options.
        expectedPriceCents: quoteOf(SERVICE_A).priceCents,
        expectedDurationMinutes: quoteOf(SERVICE_A).durationMinutes,
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
        catalog={catalogOf(services)}
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
      ok({
        business,
        services: [services[1]],
        catalog: catalogOf([services[1]!]),
      }),
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

describe("her catalogue, with options (CATALOG_CONTRACT.md § 8, § 10)", () => {
  const HENNE = "50000000-0000-4000-8000-000000000001";
  const TAILLE = "51000000-0000-4000-8000-000000000001";
  const FIN = "52000000-0000-4000-8000-000000000001";
  const LARGE = "52000000-0000-4000-8000-000000000002";
  const PAILLETTES = "51000000-0000-4000-8000-000000000002";
  const OUI = "52000000-0000-4000-8000-000000000003";

  const henne = {
    id: HENNE,
    name: "Motif au henné",
    description: null,
    durationMinutes: 45,
    priceCents: 3000,
    options: [
      {
        id: TAILLE,
        question: "Taille du motif",
        required: true,
        choices: [
          {
            id: FIN,
            label: "Fin",
            priceDeltaCents: 0,
            durationDeltaMinutes: 0,
          },
          {
            id: LARGE,
            label: "Large",
            priceDeltaCents: 1250,
            durationDeltaMinutes: 20,
          },
        ],
      },
      {
        id: PAILLETTES,
        question: "Paillettes ?",
        required: false,
        choices: [
          {
            id: OUI,
            label: "Oui",
            priceDeltaCents: 300,
            durationDeltaMinutes: 0,
          },
        ],
      },
    ],
  };
  const catalog: PublicCatalog = {
    currency: "EUR",
    groups: [
      { category: { id: "c-mains", name: "Mains" }, services: [henne] },
      {
        category: null,
        services: [{ ...catalogOf(services).groups[0]!.services[1]! }],
      },
    ],
  };
  /**
   * The server's quote. Deliberately NOT the sum a browser would make
   * (+1 € on each answer): the page must show the server's numbers.
   */
  const quoteFor = (ids: string[]) => ({
    serviceName: "Motif au henné",
    durationMinutes: 45 + (ids.includes(LARGE) ? 20 : 0),
    priceCents:
      3100 + (ids.includes(LARGE) ? 1350 : 0) + (ids.includes(OUI) ? 400 : 0),
    currency: "EUR",
    options: [
      ids.includes(LARGE)
        ? {
            optionId: TAILLE,
            question: "Taille du motif",
            choiceId: LARGE,
            label: "Large",
            priceDeltaCents: 1250,
            durationDeltaMinutes: 20,
          }
        : {
            optionId: TAILLE,
            question: "Taille du motif",
            choiceId: FIN,
            label: "Fin",
            priceDeltaCents: 0,
            durationDeltaMinutes: 0,
          },
      ...(ids.includes(OUI)
        ? [
            {
              optionId: PAILLETTES,
              question: "Paillettes ?",
              choiceId: OUI,
              label: "Oui",
              priceDeltaCents: 300,
              durationDeltaMinutes: 0,
            },
          ]
        : []),
    ],
  });
  const choicesAsked = () =>
    api.availability.mock.calls.map(([, , choices]) => choices ?? "");

  beforeEach(() => {
    api.availability.mockImplementation((_, date, choices) =>
      ok({
        date,
        timezone: TZ,
        slots: slotsFor(date),
        quote: quoteFor(choices ? choices.split(",") : []),
      }),
    );
    api.business.mockImplementation(() => ok({ business, services, catalog }));
  });

  const renderCatalog = () =>
    render(<PublicBooking business={business} catalog={catalog} />);
  const toOptions = async () => {
    renderCatalog();
    fireEvent.click(screen.getByRole("button", { name: /Motif au henné/ }));
    await screen.findByRole("heading", {
      name: "Personnalisez votre prestation",
    });
  };
  const toReviewWithOptions = async () => {
    await toOptions();
    fireEvent.click(screen.getByRole("radio", { name: /Large/ }));
    await screen.findByText(/1 h 05 · 44,50\s€/);
    fireEvent.click(screen.getByRole("button", { name: "Choisir un créneau" }));
    await screen.findByRole("heading", { name: "Choisissez un créneau" });
    fireEvent.click(await slotButton("09:30"));
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    fillContact();
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
  };

  it("her categories in her order, those without one last; a price that options can raise says « dès »", () => {
    renderCatalog();
    expect(
      screen.getByRole("heading", { level: 3, name: "Mains" }),
    ).toBeTruthy();
    const mains = within(screen.getByRole("list", { name: "Mains" }));
    expect(mains.getByText(/dès 45 min · 30,00\s€/)).toBeTruthy();
    const rest = within(screen.getByRole("list", { name: "Prestations" }));
    expect(rest.getByText(/1 h 15 · 65,50\s€/)).toBeTruthy();
    expect(rest.queryByText(/dès/)).toBeNull();
  });

  it("a required group starts on its first answer, an optional one on none; the server's quote is shown", async () => {
    await toOptions();
    expect(screen.getByText("Étape 2 sur 5")).toBeTruthy();
    expect(
      (screen.getByRole("radio", { name: /Fin/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByRole("radio", { name: /^Sans/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(choicesAsked()).toEqual([FIN]);
    // 31,00 €: the server's number, not 30 + 0 added up here.
    expect(await screen.findByText(/45 min · 31,00\s€/)).toBeTruthy();
    // A required group has no "none".
    const taille = within(
      screen.getByRole("group", { name: /Taille du motif/ }),
    );
    expect(taille.queryByRole("radio", { name: /^Sans/ })).toBeNull();
    expect(taille.getByText(/\+12,50\s€ · \+20 min/)).toBeTruthy();
  });

  it("every answer reads the slots and the quote again", async () => {
    await toOptions();
    await screen.findByText(/45 min · 31,00\s€/);
    fireEvent.click(screen.getByRole("radio", { name: /Large/ }));
    await screen.findByText(/1 h 05 · 44,50\s€/);
    fireEvent.click(screen.getByRole("radio", { name: /^Oui/ }));
    await screen.findByText(/1 h 05 · 48,50\s€/);
    expect(choicesAsked()).toEqual([FIN, LARGE, `${LARGE},${OUI}`]);
    fireEvent.click(screen.getByRole("radio", { name: /^Sans/ }));
    await screen.findByText(/1 h 05 · 44,50\s€/);
  });

  it("books her answers with the quote she saw; the review and the confirmation say them", async () => {
    await toReviewWithOptions();
    expect(screen.getByText("Taille du motif")).toBeTruthy();
    expect(screen.getByText("Large")).toBeTruthy();
    expect(screen.getByText(/^44,50\s€$/)).toBeTruthy();
    api.booking.mockImplementationOnce(() =>
      ok(
        {
          booking: bookingFor({
            serviceName: "Motif au henné",
            durationMinutes: 65,
            priceCents: 4450,
            options: quoteFor([LARGE]).options,
          }),
        },
        201,
      ),
    );
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    expect(bookingBodies()[0]).toMatchObject({
      serviceId: HENNE,
      optionChoiceIds: [LARGE],
      expectedPriceCents: 4450,
      expectedDurationMinutes: 65,
    });
    expect(screen.getByText("Large")).toBeTruthy();
  });

  it("quote_changed: nothing booked, the new quote shown on the same slot before she confirms again", async () => {
    await toReviewWithOptions();
    api.booking.mockImplementationOnce(() => refuse(409, "quote_changed"));
    // Meanwhile the business raised "Large".
    api.availability.mockImplementation((_, date) =>
      ok({
        date,
        timezone: TZ,
        slots: slotsFor(date),
        quote: { ...quoteFor([LARGE]), priceCents: 5000 },
      }),
    );
    fireEvent.click(confirmButton());
    await screen.findByText("Le prix ou la durée a changé");
    expect(
      screen.getByRole("heading", { name: "Vérifiez et confirmez" }),
    ).toBeTruthy();
    expect(screen.getByText(/^50,00\s€$/)).toBeTruthy();
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor({ priceCents: 5000 }) }, 201),
    );
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    const [first, second] = bookingBodies();
    expect(first!.expectedPriceCents).toBe(4450);
    expect(second!.expectedPriceCents).toBe(5000);
  });

  it("resent after leaving the page, the price changed meanwhile: her service and answers come back with the new quote (Codex review of #50)", async () => {
    api.booking.mockImplementationOnce(lost);
    await toReviewWithOptions();
    fireEvent.click(confirmButton());
    await screen.findByText("Réservation non confirmée");
    cleanup();

    // Back on the page: nothing chosen in this render, only the request
    // kept on her device.
    renderCatalog();
    api.booking.mockImplementationOnce(() => refuse(409, "quote_changed"));
    api.availability.mockImplementation((_, date) =>
      ok({
        date,
        timezone: TZ,
        slots: slotsFor(date),
        quote: { ...quoteFor([LARGE]), priceCents: 5000 },
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Renvoyer la même demande" }),
    );
    await screen.findByText("Le prix ou la durée a changé");
    expect(
      await screen.findByRole("heading", { name: "Vérifiez et confirmez" }),
    ).toBeTruthy();
    expect(screen.getByText(/^50,00\s€$/)).toBeTruthy();
    expect(screen.getAllByText(/Large/).length).toBeGreaterThan(0);
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor({ priceCents: 5000 }) }, 201),
    );
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    const [first, , third] = bookingBodies();
    expect(third!.serviceId).toBe(first!.serviceId);
    expect(third!.optionChoiceIds).toEqual([LARGE]);
    expect(third!.expectedPriceCents).toBe(5000);
  });

  it("option_choice_unavailable: the catalogue is read again, she chooses again, nothing picked silently", async () => {
    await toReviewWithOptions();
    api.booking.mockImplementationOnce(() =>
      refuse(409, "option_choice_unavailable"),
    );
    // "Large" was withdrawn meanwhile.
    const withdrawn: PublicCatalog = {
      ...catalog,
      groups: [
        {
          category: catalog.groups[0]!.category,
          services: [
            {
              ...henne,
              options: [
                {
                  ...henne.options[0]!,
                  choices: [henne.options[0]!.choices[0]!],
                },
                henne.options[1]!,
              ],
            },
          ],
        },
        catalog.groups[1]!,
      ],
    };
    api.business.mockImplementation(() =>
      ok({ business, services, catalog: withdrawn }),
    );
    fireEvent.click(confirmButton());
    await screen.findByText("Les options ont changé");
    expect(
      screen.getByRole("heading", { name: "Personnalisez votre prestation" }),
    ).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Large/ })).toBeNull();
    await waitFor(() =>
      expect(
        (screen.getByRole("radio", { name: /Fin/ }) as HTMLInputElement)
          .checked,
      ).toBe(true),
    );
    expect(choicesAsked().at(-1)).toBe(FIN);
  });

  it("options_required while reading slots: back to her options, the group now required answered first", async () => {
    await toOptions();
    api.availability.mockImplementationOnce(() =>
      refuse(422, "options_required"),
    );
    fireEvent.click(screen.getByRole("radio", { name: /^Oui/ }));
    await screen.findByText("Les options ont changé");
  });

  it("without options, the price and duration she accepted are sent too (Codex audit)", async () => {
    renderCatalog();
    fireEvent.click(screen.getByRole("button", { name: /Rehaussement/ }));
    await screen.findByRole("heading", { name: "Choisissez un créneau" });
    expect(screen.getByText("Étape 2 sur 4")).toBeTruthy();
    fireEvent.click(await slotButton("09:30"));
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    fillContact();
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor() }, 201),
    );
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    expect(Object.keys(bookingBodies()[0]!).sort()).toEqual(
      [
        "email",
        "expectedDurationMinutes",
        "expectedPriceCents",
        "firstName",
        "requestId",
        "serviceId",
        "slug",
        "startsAt",
      ].sort(),
    );
    // No answers to send: no optionChoiceIds.
    expect(bookingBodies()[0]).not.toHaveProperty("optionChoiceIds");
  });
});

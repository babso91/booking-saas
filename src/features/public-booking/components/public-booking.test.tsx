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
import { StrictMode } from "react";
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
  waitlistEnabled: false,
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
  calendar:
    vi.fn<
      (serviceId: string, from: string, through: string) => Promise<Response>
    >(),
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
  api.calendar.mockImplementation((_, from) =>
    ok({ days: [{ date: from, slots: slotsFor(from) }] }),
  );
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/bookings") {
      return api.booking(JSON.parse(String(init?.body)));
    }
    if (url.pathname.endsWith("/availability")) {
      if (url.searchParams.has("through"))
        return api.calendar(
          url.searchParams.get("serviceId")!,
          url.searchParams.get("date")!,
          url.searchParams.get("through")!,
        );
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
/** Her name and phone, one tap away (Higani point 66). */
const openOptional = () =>
  fireEvent.click(
    screen.getByRole("button", {
      name: "Ajouter mon nom ou un téléphone (facultatif)",
    }),
  );
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
  it("a service tapped there opens on its quote and slots, even when React mounts it twice", async () => {
    // StrictMode (development, her studio's preview) unmounts and remounts
    // the flow at once: the first read is aborted, the second must be asked.
    render(
      <StrictMode>
        <PublicBooking
          business={business}
          catalog={catalogOf(services)}
          embedded
          initialServiceId={SERVICE_B}
        />
      </StrictMode>,
    );
    await flush();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Choisissez un créneau" }),
      ).toBeTruthy(),
    );
    await waitFor(() =>
      expect(screen.getByText(/1 h 15 · 65,50\s€/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Calcul du prix/)).toBeNull();
    expect(
      api.availability.mock.calls.some(
        ([serviceId]) => serviceId === SERVICE_B,
      ),
    ).toBe(true);
  });

  // Higani point 2: her site said « Prochaine dispo · jeu. 26 nov. »; the
  // booking opens on that day, not on today.
  it("a service tapped with its next slot opens on that day", async () => {
    const day = addDays(today, 3);
    render(
      <PublicBooking
        business={business}
        catalog={catalogOf(services)}
        embedded
        initialServiceId={SERVICE_B}
        initialDate={day}
      />,
    );
    await screen.findByRole("heading", { name: "Choisissez un créneau" });
    await waitFor(() =>
      expect(api.availability).toHaveBeenCalledWith(SERVICE_B, day),
    );
    expect(api.availability).not.toHaveBeenCalledWith(SERVICE_B, today);
  });

  it.each([
    ["in the past", -1],
    ["past her booking horizon", business.maximumBookingAdvanceDays + 1],
  ])("a day %s is not kept: today instead", async (_, offset) => {
    render(
      <PublicBooking
        business={business}
        catalog={catalogOf(services)}
        embedded
        initialServiceId={SERVICE_B}
        initialDate={addDays(today, offset)}
      />,
    );
    await screen.findByRole("heading", { name: "Choisissez un créneau" });
    await waitFor(() =>
      expect(api.availability).toHaveBeenCalledWith(SERVICE_B, today),
    );
  });

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

describe("published booking formats", () => {
  it.each([
    ["calendar", "Mois"],
    ["chronological", "Semaine"],
  ] as const)(
    "%s opens on real dates, with a fresh quote before contact",
    async (format, view) => {
      render(
        <PublicBooking
          business={business}
          catalog={catalogOf([services[0]!])}
          format={format}
        />,
      );
      expect(
        (await screen.findByRole("button", { name: view })).getAttribute(
          "aria-pressed",
        ),
      ).toBe("true");
      if (format === "calendar") {
        fireEvent.click(
          await screen.findByRole("button", { name: /, 2 créneaux$/ }),
        );
      }
      fireEvent.click(await slotButton("09:30"));
      expect(
        await screen.findByRole("heading", { name: "Vos coordonnées" }),
      ).toBeTruthy();
      expect(api.availability).toHaveBeenCalledWith(SERVICE_A, today);
    },
  );

  it("showcase displays the site's submitted work and the live service prices", async () => {
    render(
      <PublicBooking
        business={business}
        catalog={catalogOf(services)}
        format="showcase"
        gallery={
          <figure>
            <figcaption>Volume mixte</figcaption>
          </figure>
        }
      />,
    );
    expect(screen.getByText("Volume mixte")).toBeTruthy();
    await chooseService();
    expect(await slotButton("09:30")).toBeTruthy();
  });

  it("guided follows the selected category and offers completed steps for editing", async () => {
    const catalog = catalogOf(services);
    const [a, b] = catalog.groups[0]!.services;
    catalog.groups = [
      { category: { id: "cils", name: "Cils" }, services: [a!] },
      { category: { id: "soins", name: "Soins" }, services: [b!] },
    ];
    render(
      <PublicBooking business={business} catalog={catalog} format="guided" />,
    );
    const progress = within(
      screen.getByRole("navigation", { name: "Étapes de la réservation" }),
    );
    expect(progress.queryByRole("button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Soins/ }));
    expect(screen.queryByRole("button", { name: /Pose cil à cil/ })).toBeNull();
    await chooseService("Rehaussement");
    fireEvent.click(progress.getByRole("button", { name: "Prestation" }));
    expect(screen.getByRole("button", { name: /Cils/ })).toBeTruthy();
  });

  // Higani point 54: "Réserver" on one of her services, in every format she
  // can publish, opens on that service, never on the list again.
  it.each([
    "classic",
    "calendar",
    "chronological",
    "showcase",
    "guided",
  ] as const)(
    "%s: a service chosen on her site is already chosen here",
    async (format) => {
      render(
        <PublicBooking
          business={business}
          catalog={catalogOf(services)}
          format={format}
          embedded
          initialServiceId={SERVICE_B}
        />,
      );
      await screen.findByRole("heading", { name: "Choisissez un créneau" });
      expect(screen.queryByRole("list", { name: "Prestations" })).toBeNull();
      await waitFor(() =>
        expect(
          api.availability.mock.calls.some(([id]) => id === SERVICE_B),
        ).toBe(true),
      );
      expect(api.availability.mock.calls.some(([id]) => id === SERVICE_A)).toBe(
        false,
      );
    },
  );

  it("studio preview reaches review without posting a booking", async () => {
    render(
      <PublicBooking
        business={business}
        catalog={catalogOf(services)}
        format="guided"
        preview
      />,
    );
    await toReview();
    const button = screen.getByRole("button", {
      name: "Confirmation désactivée dans l’aperçu",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(api.booking).not.toHaveBeenCalled();
  });
});

// Higani point 37: a long catalogue (eight services and more) offers a
// search by name, category or a word of the description; the results
// replace the list, in her order, whatever the format.
describe("a long catalogue: find a service", () => {
  const item = (
    n: number,
    name: string,
    description: string | null = null,
  ) => ({
    id: `30000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`,
    name,
    description,
    durationMinutes: 60,
    priceCents: 5000,
    options: [],
  });
  const long: PublicCatalog = {
    currency: "EUR",
    groups: [
      {
        category: { id: "cils", name: "Cils & regard" },
        services: [
          item(1, "Volume russe"),
          item(2, "Volume mixte"),
          item(3, "Rehaussement", "Courbés et teintés."),
        ],
      },
      {
        category: { id: "ongles", name: "Ongles" },
        services: [
          item(4, "Pose gel"),
          item(5, "Semi-permanent mains"),
          item(6, "Dépose"),
        ],
      },
      {
        category: null,
        services: [
          item(7, "Restructuration sourcils"),
          item(8, "Teinture sourcils"),
        ],
      },
    ],
  };
  it("point 33: shortcuts to her categories, those without one named; a shortcut leads to its heading", async () => {
    render(<PublicBooking business={business} catalog={long} />);
    const nav = within(screen.getByRole("navigation", { name: "Catégories" }));
    expect(nav.getAllByRole("button").map((item) => item.textContent)).toEqual([
      "Cils & regard",
      "Ongles",
      "Autres prestations",
    ]);
    fireEvent.click(nav.getByRole("button", { name: "Ongles" }));
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 3, name: "Ongles" }),
    );
    // Searching, the shortcuts step aside.
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Rechercher une prestation" }),
      { target: { value: "gel" } },
    );
    expect(screen.queryByRole("navigation", { name: "Catégories" })).toBeNull();
  });

  it("point 33: a short catalogue has no shortcuts", () => {
    render(
      <PublicBooking
        business={business}
        catalog={{ ...long, groups: long.groups.slice(0, 1) }}
      />,
    );
    expect(screen.queryByRole("navigation", { name: "Catégories" })).toBeNull();
  });

  it("point 35: a long description, three lines first, read in full on demand; her line breaks kept", () => {
    const description =
      "Inclus : dépose, soin et pose.\nRésultat : un regard ouvert pendant six semaines.\nÀ prévoir : venir sans maquillage.\nRetouche conseillée à trois semaines.";
    render(
      <PublicBooking
        business={business}
        catalog={{
          currency: "EUR",
          groups: [
            {
              category: null,
              services: [item(9, "Volume russe", description)],
            },
          ],
        }}
      />,
    );
    const text = screen.getByText(/Inclus : dépose/);
    expect(text.className).toContain("line-clamp-3");
    expect(text.className).toContain("whitespace-pre-line");
    const more = screen.getByRole("button", { name: "Lire la suite" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(text.className).not.toContain("line-clamp-3");
    expect(
      screen
        .getByRole("button", { name: "Réduire" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("point 35: a short description has no « Lire la suite »", () => {
    render(<PublicBooking business={business} catalog={long} />);
    expect(screen.getByText("Courbés et teintés.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lire la suite" })).toBeNull();
  });

  const searchBox = () =>
    screen.getByRole("searchbox", { name: "Rechercher une prestation" });
  const search = (value: string) =>
    fireEvent.change(searchBox(), { target: { value } });
  const all = long.groups.flatMap((group) =>
    group.services.map((service) => service.name),
  );
  /** The services offered, in the order shown. */
  const names = () =>
    screen
      .queryAllByRole("button")
      .map((button) => all.find((name) => button.textContent?.startsWith(name)))
      .filter(Boolean);

  beforeEach(() => {
    api.business.mockImplementation(() =>
      ok({ business, services, catalog: long }),
    );
  });

  it("a short catalogue has no search field", () => {
    renderPage();
    expect(
      screen.queryByRole("searchbox", { name: "Rechercher une prestation" }),
    ).toBeNull();
  });

  it("by name, by category, by a word of the description; says how many", () => {
    render(<PublicBooking business={business} catalog={long} />);
    expect(names()).toHaveLength(8);
    search("sourcils");
    expect(names()).toEqual(["Restructuration sourcils", "Teinture sourcils"]);
    expect(screen.getByText("2 prestations")).toBeTruthy();
    search("ONGLES");
    expect(names()).toEqual(["Pose gel", "Semi-permanent mains", "Dépose"]);
    expect(screen.getByRole("heading", { name: "Ongles" })).toBeTruthy();
    search("teintes");
    expect(names()).toEqual(["Rehaussement"]);
    expect(screen.getByText("1 prestation")).toBeTruthy();
  });

  it("nothing found: says so, and one tap shows her whole catalogue again", () => {
    render(<PublicBooking business={business} catalog={long} />);
    search("brushing");
    expect(names()).toEqual([]);
    expect(
      screen.getByText("Aucune prestation ne correspond à « brushing »"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Effacer la recherche" }),
    );
    expect(names()).toHaveLength(8);
    expect((searchBox() as HTMLInputElement).value).toBe("");
  });

  it("guided: a search goes past the choice of a category, and back", async () => {
    render(
      <PublicBooking business={business} catalog={long} format="guided" />,
    );
    expect(
      screen.getByRole("heading", {
        name: "Quelle catégorie vous intéresse ?",
      }),
    ).toBeTruthy();
    search("gel");
    expect(
      screen.getByRole("heading", { name: "Choisissez une prestation" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Ongles/ })).toBeNull();
    search("");
    expect(screen.getByRole("button", { name: /^Ongles/ })).toBeTruthy();
    search("gel");
    await chooseService("Pose gel");
    expect(api.availability.mock.calls[0]![0]).toBe(item(4, "").id);
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

  describe("a day or a period without a slot (point 60)", () => {
    const daysFrom = (from: string, through: string) => {
      const list: string[] = [];
      for (let day = from; day <= through; day = addDays(day, 1))
        list.push(day);
      return list;
    };
    /** Her calendar read: slots on `open` only. */
    const openOn =
      (open: string) => (_: string, from: string, through: string) =>
        ok({
          days: daysFrom(from, through).map((date) => ({
            date,
            slots: date === open ? slotsFor(date) : [],
          })),
        });
    const dayOpenOn = (open: string) =>
      api.availability.mockImplementation((_, date) =>
        ok({
          date,
          timezone: TZ,
          slots: date === open ? slotsFor(date) : [],
          quote: quoteOf(SERVICE_A),
        }),
      );
    const horizon = addDays(today, business.maximumBookingAdvanceDays);

    it("an empty day offers her next real slot, past the closed days", async () => {
      const open = addDays(today, 4);
      dayOpenOn(open);
      api.calendar.mockImplementation(openOn(open));
      renderPage();
      await chooseService();
      expect(
        await screen.findByText("Aucun créneau disponible ce jour-là."),
      ).toBeTruthy();
      const next = await screen.findByRole("button", {
        name: `Prochain créneau : ${dayLabel(open)} à 09:30`,
      });
      // Read after that day, up to her horizon, by her real calendar.
      expect(api.calendar).toHaveBeenCalledWith(
        SERVICE_A,
        addDays(today, 1),
        horizon,
      );
      expect(screen.queryByRole("button", { name: /^Voir le / })).toBeNull();
      fireEvent.click(next);
      expect(await slotButton("09:30")).toBeTruthy();
      expect(api.availability).toHaveBeenLastCalledWith(SERVICE_A, open);
    });

    it("nothing up to her horizon is said, with another service to try", async () => {
      dayOpenOn("");
      api.calendar.mockImplementation(openOn(""));
      renderPage();
      await chooseService();
      expect(
        await screen.findByText(
          `Les réservations en ligne sont ouvertes jusqu’au ${dayLabel(horizon)} : aucun créneau d’ici là.`,
        ),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "Choisir une autre prestation" }),
      );
      expect(
        await screen.findByRole("button", { name: /Pose cil à cil/ }),
      ).toBeTruthy();
    });

    it("if that search cannot be read, the next day stays one tap away", async () => {
      dayOpenOn(addDays(today, 1));
      api.calendar.mockImplementation(() => refuse(500, "internal"));
      renderPage();
      await chooseService();
      const tomorrow = addDays(today, 1);
      fireEvent.click(
        await screen.findByRole("button", {
          name: `Voir le ${dayLabel(tomorrow)}`,
        }),
      );
      expect(await slotButton("09:30")).toBeTruthy();
      expect(api.availability).toHaveBeenLastCalledWith(SERVICE_A, tomorrow);
    });

    it("an empty week offers the next slot and moves there", async () => {
      const open = addDays(today, 12);
      api.calendar.mockImplementation(openOn(open));
      render(
        <PublicBooking
          business={business}
          catalog={catalogOf([services[0]!])}
          format="chronological"
        />,
      );
      expect(
        await screen.findByText("Aucun créneau disponible sur cette période."),
      ).toBeTruthy();
      fireEvent.click(
        await screen.findByRole("button", {
          name: `Prochain créneau : ${dayLabel(open)} à 09:30`,
        }),
      );
      expect(
        await screen.findByRole("heading", { name: dayLabel(open) }),
      ).toBeTruthy();
      expect(
        screen.queryByText("Aucun créneau disponible sur cette période."),
      ).toBeNull();
    });
  });

  // Higani, 27/11: « une micro seconde ça écrit durée », a jump between two
  // days. A day does not change her price: it stays while the day loads.
  it("another day keeps her price on screen while its slots load", async () => {
    renderPage();
    await chooseService();
    expect(await screen.findByText(/2 h · 110,00\s€/)).toBeTruthy();
    const later = deferred();
    api.availability.mockImplementationOnce(() => later.promise);
    const tomorrow = addDays(today, 1);
    fireEvent.click(
      screen.getByRole("button", {
        name: new RegExp(`, ${dayLabel(tomorrow)}$`),
      }),
    );
    await flush();
    expect(screen.queryByText(/Calcul du prix/)).toBeNull();
    expect(screen.getByText(/2 h · 110,00\s€/)).toBeTruthy();
    later.resolve(
      await ok({
        date: tomorrow,
        timezone: TZ,
        slots: slotsFor(tomorrow),
        quote: quoteOf(SERVICE_A),
      }),
    );
    expect(
      await screen.findByRole("list", {
        name: `Créneaux du ${dayLabel(tomorrow)}`,
      }),
    ).toBeTruthy();
    expect(screen.getByText(/2 h · 110,00\s€/)).toBeTruthy();
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
    openOptional();
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

// Higani 56, 69, 77: where she receives and how to reach her, before
// and after booking, from what her site publishes; her general location
// when she publishes no address.
describe("where, and how to reach her", () => {
  const place = {
    address: "12 rue Mercière, 69002 Lyon",
    area: "",
    instructions: "Venir démaquillée.",
    phone: "04 78 00 00 00",
    email: "contact@exemple.fr",
  };
  const book = async () => {
    await chooseService();
    fireEvent.click(await slotButton("09:30"));
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    fillContact();
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
  };

  it("her site's address before she commits, then with directions, her instructions and her contact", async () => {
    render(
      <PublicBooking
        business={business}
        catalog={catalogOf(services)}
        embedded
        place={place}
      />,
    );
    await book();
    expect(screen.getByText("Lieu")).toBeTruthy();
    expect(screen.getByText("12 rue Mercière, 69002 Lyon")).toBeTruthy();
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor() }, 201),
    );
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    expect(screen.getByText("12 rue Mercière, 69002 Lyon")).toBeTruthy();
    const directions = screen.getByRole("link", { name: /Itinéraire/ });
    expect(directions.getAttribute("href")).toMatch(
      /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=12%20rue/,
    );
    expect(directions.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("Avant de venir")).toBeTruthy();
    expect(screen.getByText("Venir démaquillée.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "04 78 00 00 00" }).getAttribute("href"),
    ).toBe("tel:0478000000");
    expect(
      screen
        .getByRole("link", { name: "contact@exemple.fr" })
        .getAttribute("href"),
    ).toBe("mailto:contact@exemple.fr");
  });

  it("her conditions are read before she commits (point 6)", async () => {
    render(
      <PublicBooking
        business={{
          ...business,
          cancellationPolicy: "Annulation gratuite jusqu’à 24 h avant.",
        }}
        catalog={catalogOf(services)}
        embedded
        place={{
          ...place,
          lateness: "Au-delà de 15 minutes, la prestation peut être écourtée.",
          noShow: "",
          companions: "Les enfants ne peuvent pas être accueillis.",
        }}
      />,
    );
    await book();
    const block = screen.getByRole("region", {
      name: "À savoir avant de confirmer",
    });
    expect(
      within(block)
        .getAllByRole("term")
        .map((term) => term.textContent),
    ).toEqual(["Annulation", "Retard", "Accompagnants", "Avant de venir"]);
    expect(
      within(block).getByText(
        "Au-delà de 15 minutes, la prestation peut être écourtée.",
      ),
    ).toBeTruthy();
    // Read before the button that commits her.
    expect(
      block.compareDocumentPosition(confirmButton()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(api.booking).not.toHaveBeenCalled();
  });

  it("without a site or terms, no conditions block; her terms alone when she has some", async () => {
    const { unmount } = render(
      <PublicBooking
        business={business}
        catalog={catalogOf(services)}
        embedded
      />,
    );
    await book();
    expect(
      screen.queryByRole("region", { name: "À savoir avant de confirmer" }),
    ).toBeNull();
    unmount();
    // Another visit, not this booking taken back (point 67).
    window.sessionStorage.clear();
    render(
      <PublicBooking
        business={{ ...business, cancellationPolicy: "48 h avant." }}
        catalog={catalogOf(services)}
        embedded
      />,
    );
    await book();
    const block = screen.getByRole("region", {
      name: "À savoir avant de confirmer",
    });
    expect(
      within(block)
        .getAllByRole("term")
        .map((term) => term.textContent),
    ).toEqual(["Annulation"]);
  });

  it("without a site: her general location, no directions, no contact she did not publish", async () => {
    render(
      <PublicBooking
        business={business}
        catalog={catalogOf(services)}
        embedded
      />,
    );
    await book();
    expect(screen.getByText("Vancouver, Main Street")).toBeTruthy();
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor() }, 201),
    );
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    expect(screen.getByText("Vancouver, Main Street")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Itinéraire/ })).toBeNull();
    expect(screen.queryByText("Contact")).toBeNull();
    expect(screen.queryByText("Avant de venir")).toBeNull();
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
    openOptional();
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

    // Her details were given already: straight back to the review, not
    // asked again (Higani point 68).
    fireEvent.click(await slotButton("14:00"));
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
    expect(screen.getByText(/Inès · ines.benali@exemple.fr/)).toBeTruthy();
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

  it("point 55: what each answer adds, line by line, then the total, before she goes on", async () => {
    await toOptions();
    fireEvent.click(screen.getByRole("radio", { name: /Large/ }));
    await screen.findByText(/1 h 05 · 44,50\s€/);
    const box = screen.getByText("Votre prestation").parentElement!;
    const rows = within(box)
      .getAllByRole("term")
      .map((term) => term.textContent);
    expect(rows[0]).toBe("Motif au henné");
    expect(rows).toContain("Taille du motif : Large");
    expect(rows.at(-1)).toBe("Total");
    expect(within(box).getByText(/^\+/)).toBeTruthy();
  });

  it("point 56: where, and her conditions on demand, before she gives her details", async () => {
    render(
      <PublicBooking
        business={{
          ...business,
          cancellationPolicy: "Gratuite jusqu’à 24 h avant.",
        }}
        catalog={catalog}
        place={{
          address: "12 rue Mercière, 69002 Lyon",
          area: "",
          instructions: "",
          phone: "",
          email: "",
          lateness: "Au-delà de 15 minutes, la séance est écourtée.",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Motif au henné/ }));
    await screen.findByRole("heading", {
      name: "Personnalisez votre prestation",
    });
    fireEvent.click(screen.getByRole("button", { name: "Choisir un créneau" }));
    await screen.findByRole("heading", { name: "Choisissez un créneau" });
    expect(screen.getByText("12 rue Mercière, 69002 Lyon")).toBeTruthy();
    const peek = screen.getByRole("button", {
      name: "Conditions : annulation, retard",
    });
    expect(screen.queryByText("Gratuite jusqu’à 24 h avant.")).toBeNull();
    fireEvent.click(peek);
    expect(screen.getByText("Gratuite jusqu’à 24 h avant.")).toBeTruthy();
    expect(
      screen.getByText("Au-delà de 15 minutes, la séance est écourtée."),
    ).toBeTruthy();
  });

  it("her categories in her order, those without one last; a price that options can raise says « dès »", () => {
    renderCatalog();
    expect(
      screen.getByRole("heading", { level: 3, name: "Mains" }),
    ).toBeTruthy();
    const mains = within(screen.getByRole("list", { name: "Mains" }));
    expect(mains.getByText(/dès 45 min · 30,00\s€/)).toBeTruthy();
    // Point 33: once others have a name, those without one say so.
    expect(
      screen.getByRole("heading", { level: 3, name: "Autres prestations" }),
    ).toBeTruthy();
    const rest = within(
      screen.getByRole("list", { name: "Autres prestations" }),
    );
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
    // Point 55: what her answer adds, said with it.
    expect(screen.getByText(/^Large \(\+/)).toBeTruthy();
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
    expect(screen.getByText(/^Large \(\+/)).toBeTruthy();
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

  // Higani point 68: changing one thing never erases the others needlessly.
  describe("back without losing anything", () => {
    const pressed = async (time: string) =>
      (await slotButton(time)).getAttribute("aria-pressed");

    it("an option changed from the review: her slot and details kept, the new price shown before she confirms", async () => {
      await toReviewWithOptions();
      fireEvent.click(
        screen.getByRole("button", { name: "Changer les options" }),
      );
      await screen.findByRole("heading", {
        name: "Personnalisez votre prestation",
      });
      fireEvent.click(screen.getByRole("radio", { name: /^Oui/ }));
      await screen.findByText(/1 h 05 · 48,50\s€/);
      fireEvent.click(
        screen.getByRole("button", { name: "Choisir un créneau" }),
      );
      await screen.findByRole("heading", { name: "Choisissez un créneau" });
      // Still offered with the new duration: still hers.
      expect(await pressed("09:30")).toBe("true");
      fireEvent.click(await slotButton("09:30"));
      // Her details were given: not asked again.
      await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
      expect(screen.getByText(/Inès · ines.benali@exemple.fr/)).toBeTruthy();
      expect(screen.getAllByText(/48,50\s€/).length).toBeGreaterThan(0);
      api.booking.mockImplementationOnce(() =>
        ok({ booking: bookingFor() }, 201),
      );
      fireEvent.click(confirmButton());
      await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
      expect(bookingBodies()[0]).toMatchObject({
        startsAt: `${today}T16:30:00.000Z`,
        optionChoiceIds: [LARGE, OUI],
        expectedPriceCents: 4850,
        expectedDurationMinutes: 65,
        firstName: "Inès",
      });
    });

    it("an option that no longer fits her slot: only the slot is chosen again", async () => {
      await toReviewWithOptions();
      fireEvent.click(
        screen.getByRole("button", { name: "Changer les options" }),
      );
      await screen.findByRole("heading", {
        name: "Personnalisez votre prestation",
      });
      // With the glitter, 09:30 is no longer offered that day.
      api.availability.mockImplementation((_, date, choices) =>
        ok({
          date,
          timezone: TZ,
          slots: choices?.includes(OUI) ? [slotsFor(date)[1]] : slotsFor(date),
          quote: quoteFor(choices ? choices.split(",") : []),
        }),
      );
      fireEvent.click(screen.getByRole("radio", { name: /^Oui/ }));
      await screen.findByText(/1 h 05 · 48,50\s€/);
      fireEvent.click(
        screen.getByRole("button", { name: "Choisir un créneau" }),
      );
      await screen.findByRole("heading", { name: "Choisissez un créneau" });
      expect(screen.queryByRole("button", { name: /à 09:30$/ })).toBeNull();
      expect(await pressed("14:00")).toBe("false");
      fireEvent.click(await slotButton("14:00"));
      await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
      expect(screen.getByText(/Inès · ines.benali@exemple.fr/)).toBeTruthy();
    });

    it("the same service chosen again from the list: her answers and her slot kept", async () => {
      await toOptions();
      fireEvent.click(screen.getByRole("radio", { name: /Large/ }));
      await screen.findByText(/1 h 05 · 44,50\s€/);
      fireEvent.click(
        screen.getByRole("button", { name: "Choisir un créneau" }),
      );
      await screen.findByRole("heading", { name: "Choisissez un créneau" });
      fireEvent.click(await slotButton("09:30"));
      await screen.findByRole("heading", { name: "Vos coordonnées" });
      fireEvent.click(
        screen.getByRole("button", { name: "Changer de créneau" }),
      );
      await screen.findByRole("heading", { name: "Choisissez un créneau" });
      fireEvent.click(
        screen.getByRole("button", { name: "Changer de prestation" }),
      );
      await screen.findByRole("heading", { name: "Choisissez une prestation" });
      fireEvent.click(screen.getByRole("button", { name: /Motif au henné/ }));
      await screen.findByRole("heading", {
        name: "Personnalisez votre prestation",
      });
      expect(
        (screen.getByRole("radio", { name: /Large/ }) as HTMLInputElement)
          .checked,
      ).toBe(true);
      await screen.findByText(/1 h 05 · 44,50\s€/);
      fireEvent.click(
        screen.getByRole("button", { name: "Choisir un créneau" }),
      );
      await screen.findByRole("heading", { name: "Choisissez un créneau" });
      expect(await pressed("09:30")).toBe("true");
    });

    it("another service: its own answers, but the day she chose and her details stay", async () => {
      await toReviewWithOptions();
      fireEvent.click(
        screen.getByRole("button", { name: "Changer les options" }),
      );
      await screen.findByRole("heading", {
        name: "Personnalisez votre prestation",
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Changer de prestation" }),
      );
      await screen.findByRole("heading", { name: "Choisissez une prestation" });
      fireEvent.click(screen.getByRole("button", { name: /Rehaussement/ }));
      await screen.findByRole("heading", { name: "Choisissez un créneau" });
      expect(api.availability).toHaveBeenLastCalledWith(SERVICE_B, today);
      fireEvent.click(await slotButton("14:00"));
      await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
      expect(screen.getByText(/Inès · ines.benali@exemple.fr/)).toBeTruthy();
    });
  });
});

// Higani point 65: where she is, and what is left.
describe("her progress, said at each step (point 65)", () => {
  const stepLine = () =>
    screen.getByText(/^Étape \d sur \d/).textContent?.replace(/\s+/g, " ");

  it("each step says its place and what follows; the last says so", async () => {
    renderPage();
    expect(stepLine()).toBe(
      "Étape 1 sur 4 · Ensuite : le créneau, vos coordonnées, puis la vérification",
    );
    await chooseService();
    expect(stepLine()).toBe(
      "Étape 2 sur 4 · Ensuite : vos coordonnées, puis la vérification",
    );
    fireEvent.click(await slotButton("09:30"));
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    expect(stepLine()).toBe("Étape 3 sur 4 · Ensuite : la vérification");
    fillContact();
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
    expect(stepLine()).toBe("Étape 4 sur 4 · Dernière étape");
  });
});

// Higani point 66: her first name and email are enough.
describe("the least to type (point 66)", () => {
  it("first name and email only; her name and phone one tap away, sent only if given", async () => {
    renderPage();
    await chooseService();
    fireEvent.click(await slotButton("09:30"));
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    expect(screen.queryByLabelText(/^Nom/)).toBeNull();
    expect(screen.queryByLabelText(/^Téléphone/)).toBeNull();
    const more = screen.getByRole("button", {
      name: "Ajouter mon nom ou un téléphone (facultatif)",
    });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fillContact();
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor() }, 201),
    );
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    expect(bookingBodies()[0]).not.toHaveProperty("lastName");
    expect(bookingBodies()[0]).not.toHaveProperty("phone");
  });

  it("opened, her name comes first, focused; given once, it stays shown", async () => {
    renderPage();
    await chooseService();
    fireEvent.click(await slotButton("09:30"));
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    openOptional();
    await waitFor(() => expect(document.activeElement).toBe(field(/^Nom/)));
    type(/^Nom/, "Benali");
    fillContact();
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
    fireEvent.click(
      screen.getByRole("button", { name: "Modifier mes coordonnées" }),
    );
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    expect(field(/^Nom/).value).toBe("Benali");
  });
});

// Higani point 67: an accident never makes her start again.
describe("her booking in progress, taken back (point 67)", () => {
  const DRAFT = `public-booking-draft:${business.slug}`;

  it("reloaded on the last step: back there, same slot read again, nothing booked until she confirms", async () => {
    const first = renderPage();
    await toReview();
    first.unmount();
    expect(api.booking).not.toHaveBeenCalled();

    renderPage();
    expect(
      await screen.findByText(
        "Votre réservation reprend là où vous l’aviez laissée",
      ),
    ).toBeTruthy();
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
    expect(screen.getByText("Inès · ines.benali@exemple.fr")).toBeTruthy();
    expect(api.booking).not.toHaveBeenCalled();
    api.booking.mockImplementationOnce(() =>
      ok({ booking: bookingFor() }, 201),
    );
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    expect(bookingBodies()).toHaveLength(1);
    // Booked: nothing left to take back.
    expect(window.sessionStorage.getItem(DRAFT)).toBeNull();
  });

  it("her slot taken meanwhile: that day's slots, her details kept", async () => {
    const first = renderPage();
    await toReview();
    first.unmount();
    api.availability.mockImplementation((serviceId, date) =>
      ok({
        date,
        timezone: TZ,
        slots: slotsFor(date).slice(1),
        quote: quoteOf(serviceId),
      }),
    );
    renderPage();
    await screen.findByRole("heading", { name: "Choisissez un créneau" });
    fireEvent.click(await slotButton("14:00"));
    // Her details are still valid: straight to the review.
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
    expect(screen.getByText("Inès · ines.benali@exemple.fr")).toBeTruthy();
  });

  it("another service asked from her site: that one opens, only her details kept", async () => {
    const first = renderPage();
    await toReview();
    first.unmount();
    render(
      <PublicBooking
        business={business}
        catalog={catalogOf(services)}
        initialServiceId={SERVICE_B}
      />,
    );
    await screen.findByRole("heading", { name: "Choisissez un créneau" });
    expect(screen.queryByText(/reprend là où/)).toBeNull();
    await waitFor(() =>
      expect(api.availability).toHaveBeenLastCalledWith(SERVICE_B, today),
    );
    fireEvent.click(await slotButton("09:30"));
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
    expect(screen.getByText("Inès · ines.benali@exemple.fr")).toBeTruthy();
  });

  it("« Recommencer »: back to her services, nothing kept of that booking", async () => {
    const first = renderPage();
    await toReview();
    first.unmount();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Recommencer" }));
    expect(
      await screen.findByRole("heading", { name: "Choisissez une prestation" }),
    ).toBeTruthy();
    expect(screen.queryByText(/reprend là où/)).toBeNull();
    expect(window.sessionStorage.getItem(DRAFT)).toBeNull();
  });

  it("the studio's preview keeps nothing", async () => {
    render(
      <PublicBooking
        business={business}
        catalog={catalogOf(services)}
        preview
      />,
    );
    await chooseService();
    fireEvent.click(await slotButton("09:30"));
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    expect(window.sessionStorage.getItem(DRAFT)).toBeNull();
  });
});

// Higani point 70: a slot chosen, a request on its way, a booking made.
describe("chosen, sending, booked: never confused (point 70)", () => {
  it("says each state in words, from the choice to the answer", async () => {
    renderPage();
    await chooseService();
    fireEvent.click(await slotButton("09:30"));
    await screen.findByRole("heading", { name: "Vos coordonnées" });
    expect(
      screen.getByText("Créneau choisi, pas encore réservé."),
    ).toBeTruthy();
    fillContact();
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    await screen.findByRole("heading", { name: "Vérifiez et confirmez" });
    expect(
      screen.getByText(
        "Ce créneau n’est pas encore réservé : il le sera quand vous confirmerez.",
      ),
    ).toBeTruthy();
    const answer = deferred();
    api.booking.mockImplementationOnce(() => answer.promise);
    fireEvent.click(confirmButton());
    expect(
      await screen.findByText(
        "Envoi de votre réservation… Restez sur cette page, la réponse arrive.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/pas encore réservé/)).toBeNull();
    answer.resolve(
      new Response(JSON.stringify({ data: { booking: bookingFor() } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await screen.findByRole("heading", { name: "Rendez-vous confirmé" });
    expect(screen.queryByText(/Envoi de votre réservation/)).toBeNull();
  });
});

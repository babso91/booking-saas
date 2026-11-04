// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgendaView } from "@/features/agenda/components/agenda-view";
import { AppShell } from "@/features/agenda/components/app-shell";
import { SAMPLE_IDENTITY } from "@/features/dashboard/fixtures/sample-identity";
import { defaultAppearance } from "@/features/appearance/appearance";
import { AppearanceProvider } from "@/features/appearance/components/appearance-provider";
import { AppearanceSettings } from "@/features/appearance/components/appearance-settings";

import {
  agenda,
  appointment,
  block,
  businessToday,
  CLIENT_A,
  instantOf,
  services,
} from "../../../../tests/support/agenda-fixtures";
import { CarnetToday } from "./carnet-today";

vi.mock(
  "next/navigation",
  async () =>
    (await import("../../../../tests/support/next-router")).nextNavigationMock,
);
vi.mock("@/features/auth/actions/auth", () => ({ signOutAction: vi.fn() }));

// The Carnet agenda is the agenda: AgendaView (its reading, its "today" checked
// with PostgreSQL, its panels, its actions), written down by CarnetAgenda. Same
// mocked server actions as the other styles: no second booking logic to test.

const actions = {
  getAgendaAction: vi.fn(),
  getAgendaAppointmentAction: vi.fn(),
  getAgendaTodayAction: vi.fn(),
  listAgendaServicesAction: vi.fn(),
  searchAgendaClientsAction: vi.fn(),
  createAppointmentAction: vi.fn(),
  updateAppointmentAction: vi.fn(),
  setAppointmentStatusAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
  createBlockAction: vi.fn(),
  updateBlockAction: vi.fn(),
  deleteBlockAction: vi.fn(),
};

vi.mock("@/features/agenda/actions/agenda", () =>
  Object.fromEntries(
    [
      "getAgendaAction",
      "getAgendaAppointmentAction",
      "getAgendaTodayAction",
      "listAgendaServicesAction",
      "searchAgendaClientsAction",
      "createAppointmentAction",
      "updateAppointmentAction",
      "setAppointmentStatusAction",
      "cancelAppointmentAction",
      "createBlockAction",
      "updateBlockAction",
      "deleteBlockAction",
    ].map((name) => [
      name,
      (...args: unknown[]) => actions[name as keyof typeof actions](...args),
    ]),
  ),
);

const ok = <T,>(data: T) => ({ ok: true as const, data });
const TODAY = "2026-09-29"; // Tuesday
const originalMatchMedia = window.matchMedia;
const carnet = { ...defaultAppearance, style: "carnet" as const };

function useViewport(wide: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches:
        query.includes("reduced-motion") ||
        (wide && query.includes("min-width: 768px")),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
}

function show(
  appointments: ReturnType<typeof appointment>[],
  blocks: ReturnType<typeof block>[] = [],
  props: Partial<Parameters<typeof AgendaView>[0]> = {},
) {
  actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
    ok(agenda(startDate, endDate, { appointments, blocks })),
  );
  return render(
    <AppearanceProvider initial={carnet}>
      <AgendaView today={TODAY} {...props} />
    </AppearanceProvider>,
  );
}

const camille = appointment({ local: `${TODAY}T10:00` });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T07:00:00Z")); // 9:00 in Paris
  Object.values(actions).forEach((mock) => mock.mockReset());
  actions.listAgendaServicesAction.mockResolvedValue(ok(services));
  actions.searchAgendaClientsAction.mockResolvedValue(ok([]));
  actions.getAgendaTodayAction.mockImplementation(async () =>
    ok(businessToday()),
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
});

describe("the week, a double page — computer", () => {
  beforeEach(() => useViewport(true));

  it("one request, seven days, the week said as a planner says it", async () => {
    show([camille]);
    await waitFor(() =>
      expect(actions.getAgendaAction).toHaveBeenCalledWith({
        startDate: "2026-09-27",
        endDate: "2026-10-04",
        includeCancelled: false,
      }),
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Septembre – octobre, semaine 40",
    );
    await screen.findByText(/28 septembre – 4 octobre 2026 · 1 rendez.vous/);
    expect(screen.getAllByRole("group", { name: /^Journée du/ })).toHaveLength(
      7,
    );
  });

  it("a visit opens the agenda's own card, and its focus comes back", async () => {
    const user = userEvent.setup();
    show([camille]);
    const visit = await screen.findByRole("button", { name: /Camille/ });
    await user.click(visit);
    const card = await screen.findByRole("dialog");
    expect(
      within(card).getByRole("heading", { name: "Rendez-vous" }),
    ).toBeTruthy();
  });

  it("a pause opens its own form, never a new visit", async () => {
    const user = userEvent.setup();
    show(
      [camille],
      [
        block({
          from: `${TODAY}T12:00`,
          to: `${TODAY}T13:00`,
          reason: "Déjeuner",
        }),
      ],
    );
    await user.click(await screen.findByRole("button", { name: /Déjeuner/ }));
    expect(
      within(await screen.findByRole("dialog")).queryByLabelText("Prestation"),
    ).toBeNull();
  });

  it("a buffer is a dotted tail, not a click target; a cancelled visit keeps none", async () => {
    const buffered = appointment({
      local: `${TODAY}T10:00`,
      bufferMinutes: 30,
    });
    const cancelled = appointment({
      local: `${TODAY}T15:00`,
      bufferMinutes: 30,
      status: "cancelled",
    });
    const { container } = show([buffered, cancelled]);
    await screen.findByRole("button", { name: /10:00/ });
    expect(container.querySelectorAll("[data-buffer]")).toHaveLength(1);
    expect(container.querySelector("button[data-buffer]")).toBeNull();
  });

  it("overlaps are side by side: both can be opened", async () => {
    show([
      camille,
      appointment({
        local: `${TODAY}T10:30`,
        client: { id: CLIENT_A, displayName: "Noor Haddad" },
      }),
    ]);
    await screen.findByRole("button", { name: /Noor Haddad/ });
    expect(screen.getByRole("button", { name: /Camille/ })).toBeTruthy();
  });

  it("a week across the year, and the repeated hour of autumn", async () => {
    show([], [], { initialDate: "2026-12-30" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Décembre – janvier, semaine 53",
    );
    await screen.findByText(/28 décembre 2026 – 3 janvier 2027/);

    const repeated = appointment({
      local: "2026-10-25T02:30",
      occurrence: "second",
    });
    actions.getAgendaAction.mockClear();
    show([repeated], [], { initialDate: "2026-10-25" });
    expect(
      (await screen.findAllByRole("button", { name: /02:30.*2/ })).length,
    ).toBeGreaterThan(0);
  });

  it("no amount anywhere on the week", async () => {
    const { container } = show([camille]);
    await screen.findByRole("button", { name: /Camille/ });
    expect(container.textContent).not.toMatch(/€|encaiss|réglé|caisse/i);
  });
});

describe("visits too close to be touched one by one — computer and tablet", () => {
  beforeEach(() => useViewport(true));

  const names = ["Ada", "Bea", "Cleo", "Dina", "Elsa", "Fanny", "Gaia", "Hana"];
  // Eight visits of 5 minutes, every 15 minutes, from 10:00.
  const tally = names.map((name, index) =>
    appointment({
      local: `${TODAY}T${String(10 + Math.floor((index * 15) / 60)).padStart(2, "0")}:${String((index * 15) % 60).padStart(2, "0")}`,
      durationMinutes: 5,
      bufferMinutes: 0,
      client: { id: `c-${name}`, displayName: `${name} Morel` },
    }),
  );

  async function bracket() {
    return screen.findByRole("button", {
      name: /^8 rendez-vous rapprochés, de 10:00 à 11:50, voir la liste$/,
    });
  }

  it("each still written at its place, one target over them all", async () => {
    show(tally);
    const day = await screen.findByRole("group", {
      name: /mardi 29 septembre.*, 8 rendez-vous/i,
    });
    await bracket();
    // No target of 20 px each, 18 px apart: none of them is a button alone.
    for (const name of names)
      expect(
        within(day).queryByRole("button", { name: new RegExp(name) }),
      ).toBeNull();
    // Drawn, each, exactly at its start.
    const strokes = day.querySelectorAll("[data-shared]");
    expect(strokes).toHaveLength(8);
  });

  it("by finger: the bracket, then her visit in the list, then its details", async () => {
    const user = userEvent.setup();
    show(tally);
    await user.click(await bracket());
    const list = await screen.findByRole("dialog", {
      name: "Rendez-vous rapprochés",
    });
    expect(list.textContent).toMatch(/mardi 29 septembre.*de 10:00 à 11:50/i);
    const rows = within(list).getAllByRole("button", { name: /Morel/ });
    expect(rows.map((row) => row.textContent)).toEqual(
      tally.map((item) =>
        expect.stringContaining(item.localStartsAt.slice(11, 16)),
      ),
    );
    await user.click(rows[2]!);
    const details = await screen.findByRole("dialog", { name: "Rendez-vous" });
    expect(details.textContent).toMatch(/Cleo Morel/);
    expect(
      screen.queryByRole("dialog", { name: "Rendez-vous rapprochés" }),
    ).toBeNull();
  });

  it("by keyboard: Enter opens the list, Escape closes it", async () => {
    const user = userEvent.setup();
    show(tally);
    const target = await bracket();
    target.focus();
    await user.keyboard("{Enter}");
    const list = await screen.findByRole("dialog", {
      name: "Rendez-vous rapprochés",
    });
    expect(target.getAttribute("aria-haspopup")).toBe("dialog");
    expect(within(list).getAllByRole("button", { name: /Morel/ })).toHaveLength(
      8,
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Rendez-vous rapprochés" }),
      ).toBeNull(),
    );
  });

  it("a short visit with room around it keeps its own target", async () => {
    show([
      appointment({
        local: `${TODAY}T14:00`,
        durationMinutes: 5,
        client: { id: "c-1", displayName: "Lou Martin" },
      }),
      camille,
    ]);
    expect(
      await screen.findByRole("button", { name: /Lou.*Lou Martin/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /rapprochés/ })).toBeNull();
  });
});

describe("a day written down — phone", () => {
  beforeEach(() => useViewport(false));

  it("one day read, its entries, its strip of dates", async () => {
    show([camille]);
    await screen.findByRole("list", { name: "Ordre du jour" });
    expect(actions.getAgendaAction.mock.calls[0]![0]).toMatchObject({
      startDate: "2026-09-28",
    });
    expect(
      within(
        screen.getByRole("group", { name: "Jours de la semaine" }),
      ).getAllByRole("button"),
    ).toHaveLength(7);
    expect(await screen.findByRole("button", { name: /Camille/ })).toBeTruthy();
  });

  it("her statuses are stamps, in words; a pause is said; free time is offered", async () => {
    const user = userEvent.setup();
    show(
      [
        appointment({
          local: `${TODAY}T08:00`,
          status: "completed",
          client: { id: CLIENT_A, displayName: "Ana Terminée" },
        }),
        appointment({
          local: `${TODAY}T10:00`,
          status: "no_show",
          client: { id: CLIENT_A, displayName: "Bea Absente" },
        }),
      ],
      [
        block({
          from: `${TODAY}T12:00`,
          to: `${TODAY}T13:00`,
          reason: "Déjeuner",
        }),
      ],
    );
    expect(await screen.findByText("Terminé")).toBeTruthy();
    expect(screen.getByText("Absente")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Déjeuner, jusqu’à 13:00/ }),
    ).toBeTruthy();
    await user.click(
      screen.getAllByRole("button", {
        name: /proposer un rendez-vous ici/,
      })[0]!,
    );
    expect(
      within(await screen.findByRole("dialog")).getByRole("heading", {
        name: "Nouveau rendez-vous",
      }),
    ).toBeTruthy();
  });

  it("a note is a reference: its text only when she asks", async () => {
    const user = userEvent.setup();
    show([
      appointment({
        local: `${TODAY}T10:00`,
        internalNotes: "Allergie au latex",
      }),
    ]);
    await screen.findByRole("button", { name: /note\s*1/ });
    expect(screen.queryByText(/Allergie au latex/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Afficher" }));
    expect(screen.getByText(/Allergie au latex/)).toBeTruthy();
  });

  it("overlaps are said; a visit across midnight keeps its own line", async () => {
    show([
      camille,
      appointment({
        local: `${TODAY}T10:30`,
        client: { id: CLIENT_A, displayName: "Noor Haddad" },
      }),
      appointment({
        local: `${TODAY}T23:30`,
        client: { id: CLIENT_A, displayName: "Lune Tardive" },
      }),
    ]);
    expect(
      await screen.findByText("2 rendez-vous se chevauchent"),
    ).toBeTruthy();
    expect(screen.getByText(/jusqu’à demain/)).toBeTruthy();
  });

  it("« + Noter » is the agenda's own form: nothing is sent before she says so", async () => {
    const user = userEvent.setup();
    show([camille]);
    await user.click(
      await screen.findByRole("button", { name: /nouveau rendez-vous/i }),
    );
    expect(
      within(await screen.findByRole("dialog")).getByRole("heading", {
        name: "Nouveau rendez-vous",
      }),
    ).toBeTruthy();
    expect(actions.createAppointmentAction).not.toHaveBeenCalled();
  });

  it("asked by a link, the form opens once, and the link is gone", async () => {
    const replace = vi.spyOn(window.history, "replaceState");
    show([camille], [], { initialCreate: true });
    expect(
      within(await screen.findByRole("dialog")).getByRole("heading", {
        name: "Nouveau rendez-vous",
      }),
    ).toBeTruthy();
    expect(replace).toHaveBeenCalledWith(null, "", "/app");
    replace.mockRestore();
  });
});

describe("today's page", () => {
  const week = (appointments: ReturnType<typeof appointment>[]) =>
    agenda("2026-09-28", "2026-10-05", { appointments });
  const page = (appointments: ReturnType<typeof appointment>[], at: string) =>
    render(
      <AppearanceProvider initial={carnet}>
        <CarnetToday
          agenda={week(appointments)}
          date={TODAY}
          serverNow={Date.parse(at)}
          frozenNow={Date.parse(at)}
        />
      </AppearanceProvider>,
    );

  it("its date, its sentence, links to the agenda's card; no money at all", () => {
    const { container } = page([camille], `${TODAY}T06:00:00Z`);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Mardi",
    );
    expect(
      screen.getByRole("link", { name: /Camille/ }).getAttribute("href"),
    ).toContain(`date=${TODAY}&rdv=${camille.id}`);
    expect(container.textContent).not.toMatch(/€|encaiss|réglé|caisse/i);
    expect(
      screen.getByRole("region", { name: "Registre du jour" }),
    ).toBeTruthy();
  });

  it("never scrolls past its own date", () => {
    page([camille], `${TODAY}T06:00:00Z`);
    expect(window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("its instant comes from the server's offsets, not the browser's zone", () => {
    expect(instantOf(`${TODAY}T10:00`)).toBe("2026-09-29T08:00:00.000Z");
    page([camille], `${TODAY}T08:30:00Z`);
    expect(screen.getByText(/Créneau en cours, fin prévue/)).toBeTruthy();
  });
});

describe("changing style in the page", () => {
  const frame = () => document.querySelector("[data-carnet-frame]");
  const style = () => document.documentElement.getAttribute("data-style");

  it("Carnet → Écrin → Classique → Carnet, with no leak; her ambiance is kept", async () => {
    const user = userEvent.setup();
    useViewport(true);
    render(
      <AppearanceProvider initial={{ ...carnet, ambiance: "lin" }}>
        <AppShell
          identity={SAMPLE_IDENTITY}
          business={{ name: "Atelier Maëlys", slug: "atelier-maelys" }}
          current="appearance"
        >
          <AppearanceSettings />
        </AppShell>
      </AppearanceProvider>,
    );
    expect(style()).toBe("carnet");
    expect(frame()).not.toBeNull();
    expect(screen.getByRole("radio", { name: /^Encre bleue/ })).toHaveProperty(
      "checked",
      true,
    );

    await user.click(screen.getByRole("radio", { name: /^Écrin/ }));
    expect(style()).toBe("ecrin");
    expect(frame()).toBeNull();

    await user.click(screen.getByRole("radio", { name: /^Classique/ }));
    expect(screen.getByRole("radio", { name: /^Lin/ })).toHaveProperty(
      "checked",
      true,
    );

    await user.click(screen.getByRole("radio", { name: /^Carnet/ }));
    expect(style()).toBe("carnet");
    expect(frame()).not.toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: /^Carnet/ }),
    );
  });
});

describe("what the prototype's till must not become", () => {
  it("no source here records, states or derives a payment", () => {
    const folder = join(process.cwd(), "src/features/dashboard/carnet");
    for (const file of readdirSync(folder).filter(
      (name) => /\.tsx?$/.test(name) && !name.includes(".test."),
    )) {
      expect(readFileSync(join(folder, file), "utf8"), file).not.toMatch(
        /priceCents|Encaiss|encaiss|Payment|takings|euros\(/,
      );
    }
  });
});

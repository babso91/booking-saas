// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgendaView } from "@/features/agenda/components/agenda-view";
import { AppShell } from "@/features/agenda/components/app-shell";
import type { AgendaDto } from "@/features/agenda/data/agenda";
import {
  defaultAppearance,
  type Appearance,
} from "@/features/appearance/appearance";
import { AppearanceProvider } from "@/features/appearance/components/appearance-provider";
import type { StyleId } from "@/features/appearance/palettes";
import type { AreaIdentity } from "@/features/dashboard/area-identity";
import { CarnetToday } from "@/features/dashboard/carnet/carnet-today";
import { StudioToday } from "@/features/dashboard/components/studio-today";
import { EcrinToday } from "@/features/dashboard/ecrin/ecrin-today";

import {
  agenda,
  appointment,
  businessToday,
  services,
} from "../../../tests/support/agenda-fixtures";

vi.mock(
  "next/navigation",
  async () =>
    (await import("../../../tests/support/next-router")).nextNavigationMock,
);
vi.mock("@/features/auth/actions/auth", () => ({ signOutAction: vi.fn() }));

// One area per identity (AppShell). Here the parent stays mounted and only
// what the server would render changes — the identity its guard resolved
// and that business's data — exactly as a refresh or a navigation on the
// same page re-renders it in Next: no artificial unmount. The server actions
// answer for whoever the session is when they are called (`session`).

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
    Object.keys({
      getAgendaAction: 0,
      getAgendaAppointmentAction: 0,
      getAgendaTodayAction: 0,
      listAgendaServicesAction: 0,
      searchAgendaClientsAction: 0,
      createAppointmentAction: 0,
      updateAppointmentAction: 0,
      setAppointmentStatusAction: 0,
      cancelAppointmentAction: 0,
      createBlockAction: 0,
      updateBlockAction: 0,
      deleteBlockAction: 0,
    }).map((name) => [
      name,
      (...args: unknown[]) => actions[name as keyof typeof actions](...args),
    ]),
  ),
);

const ok = <T,>(data: T) => ({ ok: true as const, data });
const TODAY = "2026-09-29"; // Tuesday
const originalMatchMedia = window.matchMedia;

type Area = {
  identity: AreaIdentity;
  business: { name: string; slug: string };
  appointments: ReturnType<typeof appointment>[];
  services: typeof services;
};

const A: Area = {
  identity: { userId: "u-1", businessId: "b-a", membershipId: "m-a" },
  business: { name: "Atelier Alba", slug: "atelier-alba" },
  appointments: [
    appointment({
      local: `${TODAY}T10:00`,
      client: { id: "c-a", displayName: "Camille Roux" },
      internalNotes: "Allergie au latex",
    }),
  ],
  services,
};

const B: Area = {
  identity: { userId: "u-1", businessId: "b-b", membershipId: "m-b" },
  business: { name: "Studio Berthe", slug: "studio-berthe" },
  appointments: [
    appointment({
      local: `${TODAY}T11:00`,
      client: { id: "c-b", displayName: "Inès Morel" },
      service: { id: "s-b", name: "Pose gel" },
      internalNotes: "Préfère le thé",
    }),
  ],
  services: {
    ...services,
    services: [{ ...services.services[0]!, id: "s-b", name: "Pose gel" }],
  },
};

/** The business the session holds when an action is called. */
let session: Area = A;

const agendaOf = (area: Area, startDate: string, endDate: string) =>
  agenda(startDate, endDate, { appointments: area.appointments });

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

let rendered: (area: Area) => void = () => {};

/** What the server renders for the page: the guard's identity, its data. */
function Page({
  first,
  style,
  page,
}: {
  first: Area;
  style: StyleId;
  page: (area: Area) => ReactNode;
}) {
  const [area, setArea] = useState(first);
  useEffect(() => {
    rendered = setArea;
  }, []);
  const appearance: Appearance = { ...defaultAppearance, style };
  return (
    <AppearanceProvider initial={appearance}>
      <AppShell identity={area.identity} business={area.business}>
        {page(area)}
      </AppShell>
    </AppearanceProvider>
  );
}

/** The session now holds `area`, and the page is rendered again for it. */
function serverRenders(area: Area) {
  session = area;
  act(() => rendered({ ...area, identity: { ...area.identity } }));
}

const agendaPage = () => <AgendaView today={TODAY} />;

function showAgenda(style: StyleId) {
  return render(<Page first={A} style={style} page={agendaPage} />);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T07:00:00Z")); // 9:00 in Paris
  Object.values(actions).forEach((mock) => mock.mockReset());
  session = A;
  actions.getAgendaAction.mockImplementation(async ({ startDate, endDate }) =>
    ok(agendaOf(session, startDate, endDate)),
  );
  actions.listAgendaServicesAction.mockImplementation(async () =>
    ok(session.services),
  );
  actions.searchAgendaClientsAction.mockResolvedValue(ok([]));
  actions.getAgendaTodayAction.mockImplementation(async () =>
    ok(businessToday()),
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  useViewport(true);
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
});

async function openCamille(user: ReturnType<typeof userEvent.setup>) {
  const [entry] = await screen.findAllByRole("button", {
    name: /Camille Roux/,
  });
  await user.click(entry!);
  return screen.findByRole("dialog");
}

function nothingOf(area: Area) {
  expect(screen.queryByText(/Camille Roux/)).toBeNull();
  expect(screen.queryByText(new RegExp(area.business.name))).toBeNull();
  expect(screen.queryByText(/Allergie au latex/)).toBeNull();
  expect(screen.queryByText(/Rehaussement de cils/)).toBeNull();
}

describe.each<StyleId>(["classique", "studio", "ecrin", "carnet"])(
  "A → B in %s, the page staying mounted",
  (style) => {
    it("her open appointment and its note are gone at once", async () => {
      const user = userEvent.setup();
      showAgenda(style);
      const dialog = await openCamille(user);
      expect(within(dialog).getByText("Allergie au latex")).toBeTruthy();

      serverRenders(B);

      // In the very render where B is on screen: nothing of A.
      expect(screen.queryByRole("dialog")).toBeNull();
      nothingOf(A);
      expect(screen.getAllByText(/Studio Berthe/).length).toBeGreaterThan(0);
      // B's own agenda is read, under B's session.
      expect(
        (await screen.findAllByRole("button", { name: /Inès Morel/ })).length,
      ).toBeGreaterThan(0);
      nothingOf(A);
    });

    it("a read of A answered after B is on screen is never shown", async () => {
      let answerA: (value: unknown) => void = () => {};
      actions.getAgendaAction.mockImplementationOnce(
        ({ startDate, endDate }) =>
          new Promise((resolve) => {
            answerA = () => resolve(ok(agendaOf(A, startDate, endDate)));
          }),
      );
      showAgenda(style);
      await waitFor(() => expect(actions.getAgendaAction).toHaveBeenCalled());

      serverRenders(B);
      await screen.findAllByRole("button", { name: /Inès Morel/ });

      await act(async () => answerA(undefined));
      nothingOf(A);
      expect(
        screen.getAllByRole("button", { name: /Inès Morel/ }).length,
      ).toBeGreaterThan(0);
    });

    it("A's services, read or still on their way, are never offered in B", async () => {
      const user = userEvent.setup();
      let answerA: (value: unknown) => void = () => {};
      actions.listAgendaServicesAction.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerA = () => resolve(ok(A.services));
          }),
      );
      showAgenda(style);
      await screen.findAllByRole("button", { name: /Camille Roux/ });
      // The form asks for A's services; they have not come back yet.
      const [create] = screen.getAllByRole("button", {
        name: /Nouveau rendez-vous/,
      });
      await user.click(create!);
      await screen.findByRole("dialog");

      serverRenders(B);
      expect(screen.queryByRole("dialog")).toBeNull();
      await act(async () => answerA(undefined));
      await screen.findAllByRole("button", { name: /Inès Morel/ });

      // B asks for its own, under its session; A's are nowhere.
      const [again] = screen.getAllByRole("button", {
        name: /Nouveau rendez-vous/,
      });
      await user.click(again!);
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByRole("option", { name: /Pose gel/ });
      expect(within(dialog).queryByText(/Rehaussement de cils/)).toBeNull();
      expect(actions.listAgendaServicesAction).toHaveBeenCalledTimes(2);
    });

    it("the same business under a renewed membership is another area", async () => {
      const user = userEvent.setup();
      showAgenda(style);
      await openCamille(user);
      const reads = actions.getAgendaAction.mock.calls.length;

      serverRenders({
        ...A,
        identity: { ...A.identity, membershipId: "m-a-again" },
      });

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText(/Allergie au latex/)).toBeNull();
      await waitFor(() =>
        expect(actions.getAgendaAction.mock.calls.length).toBe(reads + 1),
      );
    });

    it("rendered again for the same identity, her draft is kept", async () => {
      const user = userEvent.setup();
      showAgenda(style);
      await screen.findAllByRole("button", { name: /Camille Roux/ });
      const [create] = screen.getAllByRole("button", {
        name: /Nouveau rendez-vous/,
      });
      await user.click(create!);
      const dialog = await screen.findByRole("dialog");
      await user.type(
        within(dialog).getByLabelText(/Note interne/),
        "Apporter le nuancier",
      );
      const reads = actions.getAgendaAction.mock.calls.length;

      // A refresh: the same identity, as a new object from a new render.
      serverRenders(A);

      const still = screen.getByRole("dialog");
      expect(
        (within(still).getByLabelText(/Note interne/) as HTMLTextAreaElement)
          .value,
      ).toBe("Apporter le nuancier");
      expect(actions.getAgendaAction.mock.calls.length).toBe(reads);
    });
  },
);

describe("the session no longer vouches for the area", () => {
  it("a read refused for want of membership leaves nothing of A on screen", async () => {
    const user = userEvent.setup();
    const past = appointment({
      local: `${TODAY}T07:00`,
      client: { id: "c-a", displayName: "Camille Roux" },
      internalNotes: "Allergie au latex",
    });
    session = { ...A, appointments: [past] };
    actions.setAppointmentStatusAction.mockResolvedValue(
      ok({ ...past, status: "completed", version: 2 }),
    );
    actions.getAgendaAppointmentAction.mockResolvedValue(
      ok({ ...past, status: "completed", version: 2 }),
    );
    render(<Page first={session} style="carnet" page={agendaPage} />);
    const dialog = await openCamille(user);
    // Meanwhile her membership ends: the next read is refused.
    actions.getAgendaAction.mockResolvedValue({
      ok: false,
      error: { code: "forbidden", message: "" },
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Marquer terminé" }),
    );
    // Her confirmation, then the answer: the panel shows it and the range is
    // read again.
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Marquer terminé" }).length,
      ).toBeGreaterThan(1),
    );
    await user.click(
      screen.getAllByRole("button", { name: "Marquer terminé" }).at(-1)!,
    );

    await waitFor(() => expect(screen.queryByText(/Camille Roux/)).toBeNull());
    expect(screen.queryByText(/Allergie au latex/)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

const todays = {
  studio: StudioToday,
  ecrin: EcrinToday,
  carnet: CarnetToday,
} as const;

describe.each(["studio", "ecrin", "carnet"] as const)(
  "Aujourd’hui in %s: A → B, the page staying mounted",
  (style) => {
    const Today = todays[style];
    const todayPage = (area: Area) => (
      <Today
        agenda={agendaOf(area, "2026-09-28", "2026-10-04") as AgendaDto}
        date={TODAY}
        serverNow={Date.now()}
      />
    );

    it("notes unfolded in A are not unfolded in B", async () => {
      const user = userEvent.setup();
      render(<Page first={A} style={style} page={todayPage} />);
      await user.click(screen.getAllByRole("button", { name: "Afficher" })[0]!);
      expect(screen.getAllByText(/Allergie au latex/).length).toBeGreaterThan(
        0,
      );

      serverRenders(B);

      expect(screen.queryByText(/Allergie au latex/)).toBeNull();
      expect(screen.queryByText(/Camille Roux/)).toBeNull();
      // B's notes wait for her to ask, as on any first visit.
      expect(screen.queryByText(/Préfère le thé/)).toBeNull();
      expect(
        screen.getAllByRole("button", { name: "Afficher" }).length,
      ).toBeGreaterThan(0);
    });

    it("rendered again for the same identity, her notes stay unfolded", async () => {
      const user = userEvent.setup();
      render(<Page first={A} style={style} page={todayPage} />);
      await user.click(screen.getAllByRole("button", { name: "Afficher" })[0]!);

      serverRenders(A);

      expect(screen.getAllByText(/Allergie au latex/).length).toBeGreaterThan(
        0,
      );
    });
  },
);

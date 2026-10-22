// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientHubProfileDto } from "@/features/client-hub/types";

import { useClientHub } from "../client/session";
import {
  B1,
  B2,
  appointment,
  business,
  deferred,
  fail,
  fakeApi,
  inDays,
  loyalty,
  ok,
  profile,
} from "../testing/fake-api";
import { HubAppointmentDetail } from "./appointment-detail";
import { HubAppointments } from "./appointments";
import { HubHome } from "./hub-home";
import { HubRoot } from "./hub-shell";
import { HubLoyalty } from "./loyalty";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const MILA = business(B1, "Studio Mila");
const LUMIERE = business(B2, "Ongles Lumière");

let api: ReturnType<typeof fakeApi>;
let me: ClientHubProfileDto | null;

beforeEach(() => {
  router.replace.mockReset();
  me = profile("camille@exemple.fr", [MILA, LUMIERE]);
  api = fakeApi()
    .on("GET", /\/me$/, () =>
      me ? ok(me) : fail("client_hub_unauthenticated", 401),
    )
    .on("GET", new RegExp(`${B1}/appointments$`), (call) =>
      ok({
        items:
          call.search.get("scope") === "past"
            ? [
                appointment(
                  "p1",
                  inDays(-20),
                  "Teinture des sourcils",
                  "completed",
                ),
              ]
            : [appointment("a1", inDays(3), "Pose cil à cil")],
        nextCursor: null,
      }),
    )
    .on(
      "GET",
      new RegExp(`${B2}/appointments$`),
      ok({ items: [], nextCursor: null }),
    )
    .on("GET", new RegExp(`${B1}/loyalty$`), ok(loyalty(340)))
    .on("GET", new RegExp(`${B2}/loyalty$`), ok(loyalty(45)))
    .on(
      "GET",
      new RegExp(`${B1}/loyalty/ledger$`),
      ok({ items: [], nextCursor: null }),
    )
    .on("DELETE", /\/session$/, () => {
      me = null;
      return ok({ ended: true });
    })
    .install();
});

const inHub = (page: React.ReactNode) => render(<HubRoot>{page}</HubRoot>);

/** A hook view of the provider, to act on the session from a test. */
const probe: { current: ReturnType<typeof useClientHub> | null } = {
  current: null,
};
function Probe() {
  const hub = useClientHub();
  useEffect(() => {
    probe.current = hub;
  });
  return null;
}

describe("home", () => {
  it("each business separately: its own next appointment and its own balance, never summed", async () => {
    inHub(<HubHome />);
    const mila = await screen.findByRole("region", { name: "Studio Mila" });
    const lumiere = screen.getByRole("region", { name: "Ongles Lumière" });

    expect(await within(mila).findByText("Solde : 340 points")).toBeTruthy();
    expect(within(mila).getByText("Pose cil à cil")).toBeTruthy();
    expect(await within(lumiere).findByText("Solde : 45 points")).toBeTruthy();
    expect(within(lumiere).getByText(/Aucun rendez-vous à venir/)).toBeTruthy();
    expect(within(lumiere).queryByText("Pose cil à cil")).toBeNull();
    expect(screen.queryByText(/385/)).toBeNull();
    // Each read names its own business.
    expect(
      api.to(new RegExp(`${B1}/appointments$`))[0]!.search.get("limit"),
    ).toBe("1");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Bonjour Camille",
    );
  });

  it("first names that differ between businesses: no name is picked", async () => {
    me = profile("camille@exemple.fr", [
      MILA,
      business(B2, "Ongles Lumière", "Cami"),
    ]);
    inHub(<HubHome />);
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(
      "Bonjour",
    );
  });

  it("no business opened access yet: says what to expect, nothing else is read", async () => {
    me = profile("camille@exemple.fr", []);
    inHub(<HubHome />);
    expect(await screen.findByText("Votre espace est prêt")).toBeTruthy();
    expect(screen.getByText("camille@exemple.fr")).toBeTruthy();
    expect(
      api.calls.filter((call) => /businesses/.test(call.path)),
    ).toHaveLength(0);
    // No business: no section to navigate to.
    expect(screen.queryByRole("link", { name: "Fidélité" })).toBeNull();
  });

  it("signed out: nothing private is rendered, the sign-in page is next", async () => {
    me = null;
    inHub(<HubHome />);
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/espace/connexion"),
    );
    expect(
      api.calls.filter((call) => /businesses/.test(call.path)),
    ).toHaveLength(0);
    expect(screen.queryByText(/Bonjour/)).toBeNull();
  });
});

describe("navigation", () => {
  it("one navigation for phones (bottom) and one for larger screens, both on the current business and section", async () => {
    inHub(<HubLoyalty businessId={B2} />);
    await screen.findByRole("heading", { name: "Ma fidélité" });
    const navs = screen.getAllByRole("navigation", {
      name: "Navigation principale",
    });
    expect(navs).toHaveLength(2);
    for (const nav of navs) {
      const current = within(nav).getByRole("link", { current: "page" });
      expect(current.textContent).toContain("Fidélité");
      expect(current.getAttribute("href")).toBe(`/espace/${B2}/fidelite`);
      expect(
        within(nav)
          .getByRole("link", { name: /Rendez-vous/ })
          .getAttribute("href"),
      ).toBe(`/espace/${B2}/rendez-vous`);
    }
    const switcher = screen.getByRole("navigation", { name: "Établissements" });
    expect(
      within(switcher)
        .getByRole("link", { name: "Studio Mila" })
        .getAttribute("href"),
    ).toBe(`/espace/${B1}/fidelite`);
  });

  it("a business the profile does not list is not requested (the API would refuse it anyway)", async () => {
    const other = "33333333-3333-4333-8333-333333333333";
    inHub(<HubLoyalty businessId={other} />);
    expect(
      await screen.findByRole("heading", { name: "Établissement introuvable" }),
    ).toBeTruthy();
    expect(api.calls.filter((call) => call.path.includes(other))).toHaveLength(
      0,
    );
  });
});

describe("appointments", () => {
  it("upcoming then past: one list each, the period sent to the API, nothing of one shown in the other", async () => {
    inHub(<HubAppointments businessId={B1} />);
    expect(await screen.findByText("Pose cil à cil")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Passés" }));
    expect(await screen.findByText("Teinture des sourcils")).toBeTruthy();
    expect(screen.queryByText("Pose cil à cil")).toBeNull();
    expect(
      api
        .to(new RegExp(`${B1}/appointments$`))
        .map((call) => call.search.get("scope")),
    ).toEqual(["upcoming", "past"]);
  });

  it("pagination: the next page by its cursor, appended once", async () => {
    api.on("GET", new RegExp(`${B1}/appointments$`), (call) =>
      call.search.get("cursor") === "page-2"
        ? ok({
            items: [
              appointment("a3", inDays(40), "Remplissage"),
              appointment("a2", inDays(20), "Rehaussement"),
            ],
            nextCursor: null,
          })
        : ok({
            items: [
              appointment("a1", inDays(3), "Pose cil à cil"),
              appointment("a2", inDays(20), "Rehaussement"),
            ],
            nextCursor: "page-2",
          }),
    );
    inHub(<HubAppointments businessId={B1} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Afficher les suivants" }),
    );
    expect(await screen.findByText("Remplissage")).toBeTruthy();
    expect(screen.getAllByText("Rehaussement")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Afficher les suivants" }),
    ).toBeNull();
    const calls = api.to(new RegExp(`${B1}/appointments$`));
    expect(calls[1]!.search.get("cursor")).toBe("page-2");
    expect(calls[1]!.search.get("scope")).toBe("upcoming");
  });

  it("a late page of the previous period is never appended to the new one", async () => {
    const late = deferred<ReturnType<typeof ok>>();
    api.on("GET", new RegExp(`${B1}/appointments$`), (call) =>
      call.search.get("cursor")
        ? late.promise
        : ok({
            items: [
              call.search.get("scope") === "past"
                ? appointment(
                    "p1",
                    inDays(-20),
                    "Teinture des sourcils",
                    "completed",
                  )
                : appointment("a1", inDays(3), "Pose cil à cil"),
            ],
            nextCursor: "next",
          }),
    );
    inHub(<HubAppointments businessId={B1} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Afficher les suivants" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Passés" }));
    await screen.findByText("Teinture des sourcils");
    await act(async () => {
      late.resolve(
        ok({
          items: [appointment("a9", inDays(60), "Page tardive")],
          nextCursor: null,
        }),
      );
    });
    expect(screen.queryByText("Page tardive")).toBeNull();
  });

  it("an appointment that is not hers (or does not exist): introuvable, nothing else", async () => {
    inHub(
      <HubAppointmentDetail
        businessId={B1}
        appointmentId="99999999-9999-4999-8999-999999999999"
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Rendez-vous introuvable" }),
    ).toBeTruthy();
  });

  it("an unknown appointment asks who is signed in once, then stops (no request loop)", async () => {
    inHub(
      <HubAppointmentDetail
        businessId={B1}
        appointmentId="99999999-9999-4999-8999-999999999999"
      />,
    );
    await screen.findByRole("heading", { name: "Rendez-vous introuvable" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(api.to(/appointments\/9999/)).toHaveLength(1);
    expect(api.to(/\/me$/)).toHaveLength(2);
  });

  it("the detail shows only the contract's fields: no way to change it, the business to contact", async () => {
    api.on(
      "GET",
      new RegExp(`${B1}/appointments/a1$`),
      ok({
        ...appointment("a1", inDays(3), "Pose cil à cil"),
        business: {
          name: "Studio Mila",
          slug: "studio-mila",
          timezone: "Europe/Paris",
          location: "Paris 9e",
          cancellationPolicy: "Prévenir 24 h avant.",
        },
        // Fields a backend bug could leak: never rendered by the screen.
        internalNote: "NOTE PRIVÉE",
        cancellationReason: "MOTIF PRIVÉ",
      }),
    );
    const { container } = inHub(
      <HubAppointmentDetail businessId={B1} appointmentId="a1" />,
    );
    expect(
      await screen.findByRole("heading", { name: "Pose cil à cil" }),
    ).toBeTruthy();
    expect(screen.getByText("Prévenir 24 h avant.")).toBeTruthy();
    expect(screen.getByText(/contactez directement/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/NOTE PRIVÉE|MOTIF PRIVÉ/);
    expect(
      screen.queryByRole("button", { name: /annuler|modifier|déplacer/i }),
    ).toBeNull();
  });
});

describe("loyalty", () => {
  beforeEach(() => {
    api.on(
      "GET",
      new RegExp(`${B1}/loyalty$`),
      ok(
        loyalty(340, {
          rewards: [
            {
              id: "r1",
              name: "Soin offert",
              description: null,
              pointsRequired: 300,
              rewardType: "free_service",
              rewardValue: null,
              currency: null,
              serviceName: "Soin des cils",
              eligible: true,
              missingPoints: 0,
            },
            {
              id: "r2",
              name: "Remise de 15 €",
              description: null,
              pointsRequired: 400,
              rewardType: "fixed_discount",
              rewardValue: 1500,
              currency: "EUR",
              serviceName: null,
              eligible: false,
              missingPoints: 60,
            },
          ],
          issuedRewards: [
            {
              id: "i1",
              status: "issued",
              name: "Remise de 10 %",
              rewardType: "percentage_discount",
              rewardValue: 10,
              currency: null,
              serviceName: null,
              pointsSpent: 150,
              issuedAt: inDays(-12),
              fulfilledAt: null,
              cancelledAt: null,
            },
            {
              id: "i2",
              status: "cancelled",
              name: "Ancienne remise",
              rewardType: "fixed_discount",
              rewardValue: 500,
              currency: "EUR",
              serviceName: null,
              pointsSpent: 50,
              issuedAt: inDays(-40),
              fulfilledAt: null,
              cancelledAt: inDays(-30),
            },
          ],
        }),
      ),
    );
    api.on("GET", new RegExp(`${B1}/loyalty/ledger$`), (call) =>
      call.search.get("cursor") === "2"
        ? ok({
            items: [
              {
                id: "l3",
                type: "manual_adjustment",
                pointsDelta: -20,
                balanceAfter: 405,
                createdAt: inDays(-30),
                appointmentId: null,
                serviceName: null,
                rewardName: null,
                isReversal: false,
                reversed: false,
              },
            ],
            nextCursor: null,
          })
        : ok({
            items: [
              {
                id: "l1",
                type: "appointment_completed",
                pointsDelta: 85,
                balanceAfter: 340,
                createdAt: inDays(-12),
                appointmentId: "p1",
                serviceName: "Pose cil à cil",
                rewardName: null,
                isReversal: false,
                reversed: false,
                reason: "GESTE CONFIDENTIEL",
              },
              {
                id: "l2",
                type: "manual_adjustment",
                pointsDelta: 50,
                balanceAfter: 255,
                createdAt: inDays(-20),
                appointmentId: null,
                serviceName: null,
                rewardName: null,
                isReversal: false,
                reversed: true,
                reason: "MOTIF INTERNE",
              },
            ],
            nextCursor: "2",
          }),
    );
  });

  it("balance, rewards within reach or not, issued rewards with their status", async () => {
    inHub(<HubLoyalty businessId={B1} />);
    expect(await screen.findByText("Solde : 340 points")).toBeTruthy();
    const available = screen.getByRole("article", { name: "Soin offert" });
    expect(within(available).getByText("Disponible")).toBeTruthy();
    expect(
      within(available).getByText(/À demander à Studio Mila/),
    ).toBeTruthy();
    const missing = screen.getByRole("article", { name: "Remise de 15 €" });
    expect(within(missing).getByText(/60 points/)).toBeTruthy();
    expect(screen.getByText("À utiliser")).toBeTruthy();
    expect(screen.getByText("Annulée")).toBeTruthy();
    expect(
      screen.getByText(/Aucune réduction ne s’applique automatiquement/),
    ).toBeTruthy();
  });

  it("read only: nothing to redeem, credit, cancel or mark as used", async () => {
    inHub(<HubLoyalty businessId={B1} />);
    await screen.findByText("Solde : 340 points");
    const buttons = screen
      .getAllByRole("button")
      .map((button) => button.textContent);
    for (const label of buttons) {
      expect(label).not.toMatch(
        /échanger|utiliser|obtenir|annuler|créditer|réclamer/i,
      );
    }
  });

  it("history: labels from the type only (never the professional's reason), paginated", async () => {
    const { container } = inHub(<HubLoyalty businessId={B1} />);
    expect(await screen.findByText("Visite · Pose cil à cil")).toBeTruthy();
    expect(screen.getByText("Points offerts")).toBeTruthy();
    expect(screen.getByText("Annulé ensuite")).toBeTruthy();
    expect(container.textContent).not.toMatch(
      /GESTE CONFIDENTIEL|MOTIF INTERNE/,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Afficher les plus anciens" }),
    );
    expect(await screen.findByText("Points retirés")).toBeTruthy();
    expect(
      api.to(new RegExp(`${B1}/loyalty/ledger$`))[1]!.search.get("cursor"),
    ).toBe("2");
  });

  it("back on the tab, same customer: what was loaded stays (pages appended are kept, nothing re-read)", async () => {
    inHub(<HubLoyalty businessId={B1} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Afficher les plus anciens" }),
    );
    expect(await screen.findByText("Points retirés")).toBeTruthy();
    const reads = api.calls.length;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.getByText("Points retirés")).toBeTruthy();
    expect(api.calls.slice(reads).map((call) => call.path)).toEqual([
      "/api/client-hub/me",
    ]);
  });

  it("access revoked by the business: its reads are refused, the hub asks again and stops showing it", async () => {
    inHub(<HubLoyalty businessId={B1} />);
    await screen.findByText("Solde : 340 points");
    api.on("GET", new RegExp(`${B1}/`), fail("client_hub_not_found", 404));
    me = profile("camille@exemple.fr", [LUMIERE]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Afficher les plus anciens" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Établissement introuvable" }),
    ).toBeTruthy();
    expect(screen.queryByText("Solde : 340 points")).toBeNull();
  });
});

describe("sessions and isolation", () => {
  it("a 401 on any read: the session is over, the sign-in page says it expired", async () => {
    api.on(
      "GET",
      new RegExp(`${B1}/loyalty/ledger$`),
      ok({
        items: [
          {
            id: "l1",
            type: "appointment_completed",
            pointsDelta: 85,
            balanceAfter: 340,
            createdAt: inDays(-12),
            appointmentId: null,
            serviceName: "Pose",
            rewardName: null,
            isReversal: false,
            reversed: false,
          },
        ],
        nextCursor: "2",
      }),
    );
    inHub(<HubLoyalty businessId={B1} />);
    await screen.findByText("Solde : 340 points");
    api.on(
      "GET",
      /\/me$|\/loyalty\/ledger$/,
      fail("client_hub_unauthenticated", 401),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Afficher les plus anciens" }),
    );
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/espace/connexion"),
    );
    expect(screen.queryByText("Solde : 340 points")).toBeNull();
  });

  it("signed out, then another customer signed in: a late answer of the first is never shown, nor its late 401 obeyed", async () => {
    const lateLoyalty = deferred<ReturnType<typeof ok>>();
    api.on("GET", new RegExp(`${B1}/loyalty$`), () => lateLoyalty.promise);
    render(
      <HubRoot>
        <Probe />
        <HubLoyalty businessId={B1} />
      </HubRoot>,
    );
    await screen.findByRole("heading", { name: "Ma fidélité" });

    // Camille signs out; Inès signs in on the same browser.
    await act(async () => {
      await probe.current!.signOut(false);
    });
    me = profile("ines@exemple.fr", [business(B1, "Studio Mila", "Inès")]);
    api.on("GET", new RegExp(`${B1}/loyalty$`), ok(loyalty(12)));
    await act(async () => {
      probe.current!.signedIn({
        email: "ines@exemple.fr",
        expiresAt: new Date(Date.now() + 864e5).toISOString(),
      });
    });
    expect(await screen.findByText("Solde : 12 points")).toBeTruthy();

    // Camille's read answers now, with her data, then a 401.
    await act(async () => {
      lateLoyalty.resolve(ok(loyalty(340)));
    });
    expect(screen.queryByText("Solde : 340 points")).toBeNull();
    expect(screen.getByText("Solde : 12 points")).toBeTruthy();
    expect(probe.current!.session.status).toBe("signed-in");
  });

  it("another tab signs out: this tab drops everything at once", async () => {
    inHub(<HubLoyalty businessId={B1} />);
    await screen.findByText("Solde : 340 points");
    const other = new BroadcastChannel("client-hub-session");
    await act(async () => {
      other.postMessage({ type: "signed-out" });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    other.close();
    expect(screen.queryByText("Solde : 340 points")).toBeNull();
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/espace/connexion"),
    );
  });

  it("back on the tab with another customer signed in elsewhere: the screens start over for her", async () => {
    inHub(<HubLoyalty businessId={B1} />);
    await screen.findByText("Solde : 340 points");
    me = profile("ines@exemple.fr", [business(B1, "Studio Mila", "Inès")]);
    api.on("GET", new RegExp(`${B1}/loyalty$`), ok(loyalty(12)));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByText("Solde : 12 points")).toBeTruthy();
    expect(screen.queryByText("Solde : 340 points")).toBeNull();
  });

  it("another customer: nothing chosen on screen by the previous one is kept (the period shown)", async () => {
    inHub(<HubAppointments businessId={B1} />);
    fireEvent.click(await screen.findByRole("button", { name: "Passés" }));
    await screen.findByText("Teinture des sourcils");
    me = profile("ines@exemple.fr", [business(B1, "Studio Mila", "Inès")]);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByText("Pose cil à cil")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "À venir" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("restored from the back-forward cache: hidden at once, shown again only once checked", async () => {
    inHub(<HubLoyalty businessId={B1} />);
    await screen.findByText("Solde : 340 points");
    const held = deferred<ReturnType<typeof ok>>();
    api.on("GET", /\/me$/, () => held.promise);
    act(() => {
      const event = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(event, "persisted", { value: true });
      window.dispatchEvent(event);
    });
    expect(screen.queryByText("Solde : 340 points")).toBeNull();
    me = null;
    await act(async () => {
      held.resolve(fail("client_hub_unauthenticated", 401));
    });
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/espace/connexion"),
    );
  });

  it("signing out: the session is ended on the server, then the sign-in page", async () => {
    inHub(<HubHome />);
    fireEvent.click(await screen.findByRole("button", { name: "Mon compte" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Se déconnecter" }),
    );
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/espace/connexion"),
    );
    expect(api.to(/\/session$/, "DELETE")[0]!.path).toBe(
      "/api/client-hub/session",
    );
    expect(screen.queryByText(/Bonjour/)).toBeNull();
  });

  it("signing out everywhere asks the server for every session", async () => {
    inHub(<HubHome />);
    fireEvent.click(await screen.findByRole("button", { name: "Mon compte" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Se déconnecter de tous les appareils",
      }),
    );
    await waitFor(() => expect(api.to(/\/session$/, "DELETE")).toHaveLength(1));
    expect(api.to(/\/session$/, "DELETE")[0]!.search.get("all")).toBe("true");
  });

  it("a sign-out without answer is never presented as done", async () => {
    api.on("DELETE", /\/session$/, "network");
    inHub(<HubHome />);
    fireEvent.click(await screen.findByRole("button", { name: "Mon compte" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Se déconnecter" }),
    );
    expect(
      await screen.findByText(/La déconnexion n’a pas été confirmée/),
    ).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

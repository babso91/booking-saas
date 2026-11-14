// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocationsBookingActions } from "./contract";
import {
  memoryLocationsBooking,
  sampleLocations,
  sampleStaff,
} from "./memory-actions";
import { PlaceAndPerson } from "./place-and-person";

// Place, person, slot against an in-memory server of the PROPOSED contract
// (docs/LOCATIONS_BOOKING_PROPOSAL.md). The real guarantees (one lock,
// occupations, cabins, no double booking) are the backend's.

afterEach(cleanup);

const open = async (
  server = memoryLocationsBooking(),
  actions: LocationsBookingActions = server.actions,
) => {
  render(
    <PlaceAndPerson
      serviceId="s-lift"
      serviceName="Rehaussement de cils"
      actions={actions}
    />,
  );
  await screen.findByText("Rehaussement de cils");
  return server;
};
const press = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const slotButtons = () =>
  screen
    .queryAllByRole("button", { name: / à \d\d:\d\d$/ })
    .map((b) => b.getAttribute("aria-label"));
// 10:00 Paris on 17 November is 09:00 UTC.
const TEN = "2026-11-17T09:00:00.000Z";

describe("choosing", () => {
  it("the place comes first; the person only once a place is chosen", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "Où ?" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Avec qui ?" })).toBeNull();
    press(/Atelier Oberkampf/);
    expect(screen.getByRole("heading", { name: "Avec qui ?" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Quand ?" })).toBeNull();
  });

  it("first available is an explicit choice: every person's slots, by day", async () => {
    await open();
    press(/Atelier Oberkampf/);
    press(/Première disponibilité/);
    await screen.findByRole("button", { name: "mardi 17 novembre à 10:00" });
    expect(slotButtons()).toEqual([
      "mardi 17 novembre à 10:00",
      "mardi 17 novembre à 11:00",
      "mardi 17 novembre à 14:30",
      "mercredi 18 novembre à 09:30",
      "jeudi 19 novembre à 16:00",
    ]);
  });

  it("a place with one person skips the person step; one place skips the place step", async () => {
    await open();
    press(/Studio Montreuil/);
    expect(screen.queryByRole("heading", { name: "Avec qui ?" })).toBeNull();
    await screen.findByRole("button", { name: "vendredi 20 novembre à 15:00" });
    cleanup();
    await open(
      memoryLocationsBooking({ locations: sampleLocations.slice(0, 1) }),
    );
    expect(screen.queryByRole("heading", { name: "Où ?" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Avec qui ?" })).toBeTruthy();
  });
});

describe("holding a slot", () => {
  it("a named person is never swapped: her slot taken meanwhile is said, the place kept", async () => {
    const server = await open();
    press(/Atelier Oberkampf/);
    press(/^Inès/);
    fireEvent.click(
      await screen.findByRole("button", { name: "mardi 17 novembre à 10:00" }),
    );
    server.take("p-ines", TEN);
    press(/^Réserver le/);
    await screen.findByText(/Ce créneau vient d’être pris/);
    expect(server.holds).toBe(0);
    expect(
      screen
        .getByRole("button", { name: /Atelier Oberkampf/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await vi.waitFor(() =>
      expect(slotButtons()).not.toContain("mardi 17 novembre à 10:00"),
    );
  });

  it("with first available, the free person takes it and is not named", async () => {
    const server = await open();
    press(/Atelier Oberkampf/);
    press(/Première disponibilité/);
    fireEvent.click(
      await screen.findByRole("button", { name: "mardi 17 novembre à 10:00" }),
    );
    server.take("p-ines", TEN);
    press(/^Réserver le/);
    await screen.findByText("Créneau retenu");
    expect(document.body.textContent).toMatch(
      /avec la première personne disponible/,
    );
  });

  it("no slot with her: the switch to first available is offered, never made", async () => {
    await open(
      memoryLocationsBooking({
        staff: sampleStaff,
        open: { "p-maelys@l-paris": [["2026-11-17", "10:00"]] },
      }),
    );
    press(/Atelier Oberkampf/);
    press(/^Inès/);
    await screen.findByText(/Aucune disponibilité avec Inès/);
    expect(slotButtons()).toEqual([]);
    press("Voir la première disponibilité");
    await screen.findByRole("button", { name: "mardi 17 novembre à 10:00" });
  });

  it("hours changed meanwhile: the fresh slots are shown, place and service kept", async () => {
    const server = await open();
    press(/Studio Montreuil/);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "vendredi 20 novembre à 15:00",
      }),
    );
    server.reconfigure();
    press(/^Réserver le/);
    await screen.findByText(/Les horaires viennent de changer/);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "vendredi 20 novembre à 15:00",
      }),
    );
    press(/^Réserver le/);
    await screen.findByText("Créneau retenu");
  });

  it("a lost answer is resent with the same request id: one hold", async () => {
    const server = memoryLocationsBooking();
    let lose = true;
    const hold = vi.fn<LocationsBookingActions["hold"]>(async (input) => {
      const result = await server.actions.hold(input);
      if (lose) {
        lose = false;
        return { ok: false, error: { code: "network" } };
      }
      return result;
    });
    await open(server, { ...server.actions, hold });
    press(/Studio Montreuil/);
    const slot = await screen.findByRole("button", {
      name: "vendredi 20 novembre à 15:00",
    });
    fireEvent.click(slot);
    press(/^Réserver le/);
    await screen.findByText(/Pas de réponse/);
    fireEvent.click(
      screen.getByRole("button", { name: "vendredi 20 novembre à 15:00" }),
    );
    press(/^Réserver le/);
    await screen.findByText("Créneau retenu");
    expect(hold.mock.calls[0]?.[0].requestId).toBe(
      hold.mock.calls[1]?.[0].requestId,
    );
    expect(server.holds).toBe(1);
    expect(within(document.body).getByText(/avec Maëlys/)).toBeTruthy();
  });
});

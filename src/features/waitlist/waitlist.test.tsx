// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { WaitlistActions } from "./contract";
import { JoinWaitlist } from "./join-waitlist";
import { memoryWaitlist, sampleOffer } from "./memory-actions";
import { WaitlistOffer } from "./waitlist-offer";
import { checkJoin, eligibleDays, windowsOf } from "./windows";

// The waitlist's screens against an in-memory server of the PROPOSED
// contract (docs/WAITLIST_PROPOSAL.md). The real guarantees (matching,
// FIFO, first booking wins) are the backend's to prove.

afterEach(cleanup);

const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("her preferred moments", () => {
  it("days up to 14 ahead, never beyond the business's horizon", () => {
    expect(eligibleDays("2026-11-13", 60)).toHaveLength(15);
    expect(eligibleDays("2026-11-13", 3)).toEqual([
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
    ]);
  });

  it("days and a period become windows, in day order", () => {
    expect(windowsOf(["2026-11-15", "2026-11-14"], "afternoon")).toEqual([
      { localDate: "2026-11-14", startMinute: 720, endMinute: 1080 },
      { localDate: "2026-11-15", startMinute: 720, endMinute: 1080 },
    ]);
  });

  it("a day or « dès que possible », a name, an email and consent are required", () => {
    expect(
      checkJoin({
        anyTime: false,
        days: [],
        firstName: "",
        email: "x",
        consent: false,
      }),
    ).toEqual({
      days: expect.any(String),
      firstName: expect.any(String),
      email: expect.any(String),
      consent: expect.any(String),
    });
    expect(
      checkJoin({
        anyTime: true,
        days: [],
        firstName: "Léa",
        email: "lea@exemple.fr",
        consent: true,
      }),
    ).toEqual({});
  });
});

describe("joining", () => {
  const show = (actions: WaitlistActions, done = () => {}) =>
    render(
      <JoinWaitlist
        actions={actions}
        businessSlug="atelier"
        serviceId="s1"
        serviceName="Rehaussement de cils"
        today="2026-11-13"
        horizonDays={30}
        onDone={done}
      />,
    );

  it("sends her windows, name, email and consent; says nothing is held", async () => {
    const server = memoryWaitlist();
    show(server.actions);
    click("vendredi 13 novembre");
    click("samedi 14 novembre");
    click(/L’après-midi/);
    type("Prénom", " Léa ");
    type("Email", "Lea@Exemple.fr");
    fireEvent.click(screen.getByRole("checkbox"));
    click("Me prévenir");
    await screen.findByText("C’est noté");
    expect(screen.getByText(/Rien n’est réservé pour l’instant/)).toBeTruthy();
    expect(server.state.joined[0]).toMatchObject({
      businessSlug: "atelier",
      serviceId: "s1",
      anyTime: false,
      firstName: "Léa",
      email: "lea@exemple.fr",
      contactConsent: true,
      windows: [
        { localDate: "2026-11-13", startMinute: 720, endMinute: 1080 },
        { localDate: "2026-11-14", startMinute: 720, endMinute: 1080 },
      ],
    });
  });

  it("five days at most: the others are disabled", () => {
    show(memoryWaitlist().actions);
    for (const day of [13, 14, 15, 16, 17])
      click(new RegExp(`${day} novembre$`));
    expect(
      (
        screen.getByRole("button", {
          name: /18 novembre$/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("5/5 jours choisis.")).toBeTruthy();
  });

  it("without consent or a day, nothing is sent", () => {
    const server = memoryWaitlist();
    show(server.actions);
    type("Prénom", "Léa");
    type("Email", "lea@exemple.fr");
    click("Me prévenir");
    expect(screen.getByText(/Choisissez au moins un jour/)).toBeTruthy();
    expect(screen.getByText(/Nécessaire pour vous prévenir/)).toBeTruthy();
    expect(server.state.joined).toHaveLength(0);
  });

  it("a confirmation by email is said when the server asks for one", async () => {
    show(memoryWaitlist({ pendingConfirmation: true }).actions);
    click("Dès que possible");
    type("Prénom", "Léa");
    type("Email", "lea@exemple.fr");
    fireEvent.click(screen.getByRole("checkbox"));
    click("Me prévenir");
    await screen.findByText(/Confirmez votre demande depuis l’email/);
  });

  it("a lost answer is resent with the same request id", async () => {
    const server = memoryWaitlist();
    const ids: string[] = [];
    let lose = true;
    show({
      ...server.actions,
      join: async (input) => {
        ids.push(input.requestId);
        if (lose) {
          lose = false;
          return { ok: false, error: { code: "network" } };
        }
        return server.actions.join(input);
      },
    });
    click("Dès que possible");
    type("Prénom", "Léa");
    type("Email", "lea@exemple.fr");
    fireEvent.click(screen.getByRole("checkbox"));
    click("Me prévenir");
    await screen.findByText(/Pas de réponse/);
    click("Me prévenir");
    await screen.findByText("C’est noté");
    expect(ids[1]).toBe(ids[0]);
  });
});

describe("an offer", () => {
  const show = (actions: WaitlistActions) =>
    render(<WaitlistOffer offerId="offer-a" actions={actions} />);

  it("shows the slot, its price and time left; booked only by the server's answer", async () => {
    const server = memoryWaitlist();
    show(server.actions);
    await screen.findByRole("heading", { name: "Un créneau s’est libéré" });
    expect(document.body.textContent).toMatch(/jeudi 19 novembre · 14:00/i);
    expect(screen.getByText(/60,00\s€/)).toBeTruthy();
    expect(screen.getByText(/Offre valable encore/)).toBeTruthy();
    click("Réserver ce créneau");
    await screen.findByRole("heading", { name: "C’est réservé" });
    expect(server.state.offer.state).toBe("booked");
  });

  it("someone was faster: nothing booked, her request stays active", async () => {
    const server = memoryWaitlist();
    server.state.takenElsewhere = true;
    show(server.actions);
    await screen.findByRole("button", { name: "Réserver ce créneau" });
    click("Réserver ce créneau");
    await screen.findByText("Ce créneau vient d’être réservé");
    await screen.findByText(/Votre demande reste active/);
    expect(
      screen.queryByRole("button", { name: "Réserver ce créneau" }),
    ).toBeNull();
  });

  it("expired: said, nothing to book", async () => {
    show(
      memoryWaitlist({
        offer: sampleOffer({
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      }).actions,
    );
    await screen.findByText("Cette offre a expiré.", { exact: false });
    expect(
      screen.queryByRole("button", { name: "Réserver ce créneau" }),
    ).toBeNull();
  });

  it("the price changed: nothing booked, the new one shown to confirm again", async () => {
    const server = memoryWaitlist();
    show(server.actions);
    await screen.findByRole("button", { name: "Réserver ce créneau" });
    server.state.offer = {
      ...server.state.offer,
      quoteRevision: 2,
      priceCents: 6500,
    };
    click("Réserver ce créneau");
    await screen.findByText("Le prix ou la durée a changé");
    await screen.findByText(/65,00\s€/);
    click("Réserver ce créneau");
    await screen.findByRole("heading", { name: "C’est réservé" });
  });

  it("an unknown link says so, without detail", async () => {
    render(<WaitlistOffer offerId="nope" actions={memoryWaitlist().actions} />);
    await screen.findByText("Offre introuvable");
  });

  it("a lost answer is retried with the same request id", async () => {
    const server = memoryWaitlist();
    const ids: string[] = [];
    let lose = true;
    show({
      ...server.actions,
      claim: async (input) => {
        ids.push(input.requestId);
        if (lose) {
          lose = false;
          await server.actions.claim(input);
          return { ok: false, error: { code: "network" } };
        }
        return server.actions.claim(input);
      },
    });
    await screen.findByRole("button", { name: "Réserver ce créneau" });
    click("Réserver ce créneau");
    await screen.findByText("Pas de réponse");
    click("Réessayer");
    await screen.findByRole("heading", { name: "C’est réservé" });
    await waitFor(() => expect(ids).toHaveLength(2));
    expect(ids[1]).toBe(ids[0]);
  });
});

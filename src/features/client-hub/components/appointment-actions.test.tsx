// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ClientHubAppointmentActionsDto,
  ClientHubAppointmentDetailDto,
} from "@/features/client-hub/types";
import { businessToday } from "@/features/public-booking/client/business-time";

import {
  B1,
  appointment,
  business,
  deferred,
  fail,
  fakeApi,
  inDays,
  ok,
  profile,
} from "../testing/fake-api";
import { HubAppointmentDetail } from "./appointment-detail";
import { HubRoot } from "./hub-shell";

// Her own changes to an appointment (proposed contract,
// docs/CLIENT_HUB_ACTIONS_PROPOSAL.md), against a fake of the routes: what
// the screen offers, sends and says. The server's own guarantees
// (deadlines, concurrency, idempotence) are the backend's to prove.

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const MILA = business(B1, "Studio Mila");
const ACCOUNT = "account:camille@exemple.fr";
const STARTS = inDays(5, 13);
const DETAIL = new RegExp(`${B1}/appointments/a1$`);
const CANCEL = new RegExp(`${B1}/appointments/a1/cancel$`);
const MOVE = new RegExp(`${B1}/appointments/a1/reschedule$`);
const SLOTS = new RegExp(`${B1}/appointments/a1/reschedule-slots$`);

const open = (deadlineAt: string | null = inDays(4, 13)) => ({
  allowed: true,
  deadlineAt,
  reason: null,
});
const actions = (
  over: Partial<ClientHubAppointmentActionsDto> = {},
): ClientHubAppointmentActionsDto => ({
  version: 7,
  cancel: open(),
  reschedule: open(),
  ...over,
});

const detail = (
  over: Partial<ClientHubAppointmentDetailDto> = {},
): ClientHubAppointmentDetailDto => ({
  ...appointment("a1", STARTS, "Pose cil à cil"),
  business: {
    name: MILA.name,
    slug: MILA.slug,
    timezone: "Europe/Paris",
    location: null,
    cancellationPolicy: null,
  },
  actions: actions(),
  ...over,
});

const today = businessToday("Europe/Paris");
const slot = (hour: string) => ({
  startsAt: `${today}T${hour}:00.000Z`,
  endsAt: `${today}T${hour}:30.000Z`,
  localStartsAt: `${today}T${hour}`,
  localEndsAt: `${today}T${hour}`,
});

let api: ReturnType<typeof fakeApi>;
let current: ClientHubAppointmentDetailDto;

beforeEach(() => {
  current = detail();
  api = fakeApi()
    .servedFor(() => ACCOUNT)
    .on("GET", /\/me$/, ok(profile("camille@exemple.fr", [MILA])))
    .on("GET", DETAIL, () => ok(current))
    .on("GET", SLOTS, ok({ date: today, timezone: "Europe/Paris", slots: [] }))
    .install();
});

const show = async () => {
  render(
    <HubRoot>
      <HubAppointmentDetail businessId={B1} appointmentId="a1" />
    </HubRoot>,
  );
  await screen.findByRole("heading", { name: "Pose cil à cil" });
};
const manage = () =>
  within(
    screen.getByRole("region", {
      name: /Un empêchement|Annuler ce|Choisir un/,
    }),
  );
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));

describe("what is offered is what the server allows", () => {
  it("without `actions` (today's server): nothing to change, contact the business", async () => {
    current = detail({ actions: undefined });
    await show();
    expect(screen.queryByRole("button", { name: "Annuler" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Déplacer" })).toBeNull();
    expect(
      screen.getByText(/Rien ne peut être modifié depuis votre espace/),
    ).toBeTruthy();
  });

  it("both open: each with its deadline, and the contact notice gone", async () => {
    await show();
    expect(manage().getByRole("button", { name: "Déplacer" })).toBeTruthy();
    expect(manage().getByRole("button", { name: "Annuler" })).toBeTruthy();
    expect(manage().getAllByText(/Jusqu’au .+ à \d\d:\d\d/i).length).toBe(2);
    expect(screen.queryByText(/Rien ne peut être modifié/)).toBeNull();
  });

  it("a closed action has no button and says why", async () => {
    current = detail({
      actions: actions({
        cancel: {
          allowed: false,
          deadlineAt: null,
          reason: "policy_cutoff_passed",
        },
        reschedule: {
          allowed: false,
          deadlineAt: null,
          reason: "policy_unavailable",
        },
      }),
    });
    await show();
    expect(screen.queryByRole("button", { name: "Annuler" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Déplacer" })).toBeNull();
    expect(
      manage().getByText(/Le délai pour annuler .+ est passé/),
    ).toBeTruthy();
    expect(
      manage().getByText(/Pour déplacer ce rendez-vous, contactez/),
    ).toBeTruthy();
  });

  it("a past appointment offers nothing, whatever `actions` say", async () => {
    current = detail({ status: "completed" });
    await show();
    expect(screen.queryByRole("button", { name: "Annuler" })).toBeNull();
  });
});

describe("cancelling", () => {
  it("asks first; only the server's answer says it is cancelled", async () => {
    const answer = deferred<ReturnType<typeof ok>>();
    api.on("POST", CANCEL, () => answer.promise);
    await show();
    click("Annuler");
    expect(api.to(CANCEL, "POST")).toHaveLength(0);
    click("Oui, annuler");
    // On its way: nothing is said done.
    await screen.findByText(/reste réservé tant que l’annulation/);
    expect(screen.queryByText("Votre rendez-vous est annulé.")).toBeNull();
    expect(api.to(CANCEL, "POST")[0]!.body).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedVersion: 7,
    });

    current = detail({ status: "cancelled", actions: null });
    answer.resolve(ok(current));
    await screen.findByText("Votre rendez-vous est annulé.");
    // Read again: its state now, and nothing left to change.
    await screen.findByText("Annulé");
    expect(screen.queryByRole("button", { name: "Annuler" })).toBeNull();
  });

  it("she can keep it: nothing is sent", async () => {
    await show();
    click("Annuler");
    click("Garder mon rendez-vous");
    expect(manage().getByRole("button", { name: "Annuler" })).toBeTruthy();
    expect(api.to(CANCEL, "POST")).toHaveLength(0);
  });

  it("a lost answer is retried with the same request id", async () => {
    api.on("POST", CANCEL, "network");
    await show();
    click("Annuler");
    click("Oui, annuler");
    await screen.findByText("Pas de réponse");
    api.on("POST", CANCEL, () => {
      current = detail({ status: "cancelled", actions: null });
      return ok(current);
    });
    click("Réessayer l’annulation");
    await screen.findByText("Votre rendez-vous est annulé.");
    const [first, second] = api.to(CANCEL, "POST");
    expect((second!.body as { requestId: string }).requestId).toBe(
      (first!.body as { requestId: string }).requestId,
    );
  });

  it("the deadline passed meanwhile: said, kept, and its state read again", async () => {
    api.on("POST", CANCEL, () => {
      current = detail({
        actions: actions({
          cancel: {
            allowed: false,
            deadlineAt: null,
            reason: "policy_cutoff_passed",
          },
        }),
      });
      return fail("policy_cutoff_passed", 409);
    });
    await show();
    click("Annuler");
    click("Oui, annuler");
    await screen.findByText("Le délai est passé");
    expect(
      screen.getByText(/Votre rendez-vous est toujours réservé/),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Annuler" })).toBeNull(),
    );
    expect(api.to(DETAIL).length).toBeGreaterThan(1);
  });

  it("an answer served for another account is never shown", async () => {
    api.on("POST", CANCEL, {
      ...ok(detail()),
      account: "account:someone-else",
    });
    await show();
    click("Annuler");
    click("Oui, annuler");
    await waitFor(() => expect(api.to(CANCEL, "POST")).toHaveLength(1));
    await waitFor(() => expect(api.to(/\/me$/).length).toBeGreaterThan(1));
    expect(screen.queryByText("Votre rendez-vous est annulé.")).toBeNull();
  });
});

describe("moving", () => {
  beforeEach(() => {
    api.on(
      "GET",
      SLOTS,
      ok({
        date: today,
        timezone: "Europe/Paris",
        slots: [slot("15:00"), slot("16:30")],
      }),
    );
  });

  const toSlots = async () => {
    await show();
    click("Déplacer");
    await screen.findByRole("button", { name: "15:00" });
  };

  it("reads the day's slots for this appointment; nothing can be confirmed before a slot is chosen", async () => {
    await toSlots();
    expect(api.to(SLOTS)[0]!.search.get("date")).toBe(today);
    expect(
      (
        screen.getByRole("button", {
          name: "Confirmer le déplacement",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("shows the old and the new time and the unchanged price, then sends exactly that slot", async () => {
    api.on("POST", MOVE, () => {
      current = detail({ startsAt: slot("16:30").startsAt });
      return ok(current);
    });
    await toSlots();
    click("16:30");
    const recap = within(screen.getByLabelText("Récapitulatif du déplacement"));
    expect(recap.getByText(/16:30/)).toBeTruthy();
    expect(recap.getByText(/Pose cil à cil · 85,00\s€/)).toBeTruthy();
    click("Confirmer le déplacement");
    await screen.findByText(/Votre rendez-vous est déplacé au .+ à 16:30\./);
    expect(api.to(MOVE, "POST")[0]!.body).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedVersion: 7,
      startsAt: slot("16:30").startsAt,
    });
  });

  it("the slot was taken meanwhile: her appointment stays, the day is read again, she chooses again", async () => {
    api.on("POST", MOVE, fail("slot_unavailable", 409));
    await toSlots();
    click("15:00");
    click("Confirmer le déplacement");
    await screen.findByText("Ce créneau vient d’être pris");
    expect(
      screen.getByText(/Votre rendez-vous reste à son horaire actuel/),
    ).toBeTruthy();
    await waitFor(() => expect(api.to(SLOTS).length).toBeGreaterThan(1));
    expect(screen.queryByLabelText("Récapitulatif du déplacement")).toBeNull();
    // Another slot is a new request, never the refused one's id.
    api.on("POST", MOVE, () => ok(detail()));
    click("16:30");
    click("Confirmer le déplacement");
    await waitFor(() => expect(api.to(MOVE, "POST")).toHaveLength(2));
    const [first, second] = api.to(MOVE, "POST");
    expect((second!.body as { requestId: string }).requestId).not.toBe(
      (first!.body as { requestId: string }).requestId,
    );
  });

  it("a day without slots says so; slots that cannot be read offer a retry", async () => {
    api.on(
      "GET",
      SLOTS,
      ok({ date: today, timezone: "Europe/Paris", slots: [] }),
    );
    await show();
    click("Déplacer");
    await screen.findByText(/Aucun créneau libre ce jour-là/);
    api.on("GET", SLOTS, fail("internal", 500));
    click("Semaine suivante");
    await screen.findByText(/n’ont pas pu être chargés/);
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
  });

  it("she can change nothing: back to her appointment, nothing sent", async () => {
    await toSlots();
    click("Ne rien changer");
    expect(manage().getByRole("button", { name: "Déplacer" })).toBeTruthy();
    expect(api.to(MOVE, "POST")).toHaveLength(0);
  });
});

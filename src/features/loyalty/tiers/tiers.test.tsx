// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { memoryReferral, sampleProgress } from "./memory-actions";
import { standingOf } from "./progress";
import { ReferralCard } from "./referral-card";
import { TierProgress } from "./tier-progress";

// VIP progression and referral against the PROPOSED contract
// (docs/LOYALTY_TIERS_PROPOSAL.md). Placement only: counting is the
// server's.

afterEach(cleanup);

describe("where she stands", () => {
  it("between two tiers: the next one, what is missing, the ratio", () => {
    expect(standingOf(sampleProgress())).toMatchObject({
      current: { name: "Argent" },
      next: { name: "Or" },
      missing: 2,
      ratio: 1 / 3,
    });
  });

  it("no tier yet: counted from zero", () => {
    expect(
      standingOf(sampleProgress({ tierId: null, currentValue: 1 })),
    ).toMatchObject({ current: null, next: { name: "Argent" }, missing: 2 });
  });

  it("at the top: nothing more to reach", () => {
    expect(
      standingOf(sampleProgress({ tierId: "t-diamond", currentValue: 12 })),
    ).toMatchObject({ next: null, missing: 0, ratio: 1 });
  });
});

describe("the progression card", () => {
  it("to the client: her tier, the visits still needed and the next perk", () => {
    render(
      <TierProgress
        progress={sampleProgress()}
        timezone="Europe/Paris"
        reader="client"
      />,
    );
    expect(screen.getByText("Argent")).toBeTruthy();
    expect(
      screen.getByText(
        /Encore 2 visites pour atteindre Or : Un soin offert par an\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Visites comptées jusqu’au 1er juillet 2027/),
    ).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "33",
    );
  });

  it("to the professional: about her client, without perks promised", () => {
    render(
      <TierProgress
        progress={sampleProgress({ tierId: "t-diamond", currentValue: 11 })}
        timezone="Europe/Paris"
        reader="pro"
      />,
    );
    expect(screen.getByText(/Au niveau le plus haut\./)).toBeTruthy();
    expect(screen.getByText(/Avantage : Priorité/)).toBeTruthy();
  });
});

describe("the referral card", () => {
  it("no link yet: one is created, shown and copied; nothing is sent to anyone", async () => {
    const server = memoryReferral();
    render(
      <ReferralCard
        actions={server.actions}
        businessName="Atelier Maëlys"
        timezone="Europe/Paris"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Obtenir mon lien" }),
    );
    await screen.findByText(/parrain=demo1/);
    expect(screen.getByText(/Valable jusqu’au 15 février/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(server.state.created).toBe(1);
  });

  it("an expired link is said, and a new one can be asked", async () => {
    render(
      <ReferralCard
        actions={
          memoryReferral({
            url: "https://booking.app/old",
            expiresAt: "2026-01-01T00:00:00.000Z",
            state: "expired",
          }).actions
        }
        businessName="Atelier Maëlys"
        timezone="Europe/Paris"
      />,
    );
    await screen.findByText("Votre lien précédent n’est plus valable.");
    expect(screen.queryByText("https://booking.app/old")).toBeNull();
  });

  it("a failed creation is retried with the same request id: one link only", async () => {
    const server = memoryReferral();
    const ids: string[] = [];
    let lose = true;
    render(
      <ReferralCard
        actions={{
          ...server.actions,
          create: async (input) => {
            ids.push(input.requestId);
            if (lose) {
              lose = false;
              await server.actions.create(input);
              return { ok: false, error: { code: "network" } };
            }
            return server.actions.create(input);
          },
        }}
        businessName="Atelier Maëlys"
        timezone="Europe/Paris"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Obtenir mon lien" }),
    );
    await screen.findByText(/un seul lien sera créé/);
    fireEvent.click(screen.getByRole("button", { name: "Obtenir mon lien" }));
    await screen.findByText(/parrain=demo1/);
    await waitFor(() => expect(ids).toHaveLength(2));
    expect(ids[1]).toBe(ids[0]);
    expect(server.state.created).toBe(1);
  });
});

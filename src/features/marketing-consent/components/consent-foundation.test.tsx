// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONSENT_WORDING,
  consentCollectionOpen,
  noMarketingChoice,
  ofBusiness,
} from "../wording";
import { ConsentHistory, type ConsentEventDto } from "./consent-history";
import { MarketingOptIn } from "./marketing-opt-in";

afterEach(cleanup);

function Harness() {
  const [value, setValue] = useState(noMarketingChoice);
  return (
    <>
      <MarketingOptIn
        businessName="Maison Iris"
        value={value}
        onChange={setValue}
      />
      <output>{JSON.stringify(value)}</output>
    </>
  );
}

describe("the wording", () => {
  it("is a proposal: nothing may collect a consent with it", () => {
    expect(CONSENT_WORDING.validated).toBe(false);
    expect(consentCollectionOpen).toBe(false);
  });

  it("says « de » or « d’ » as French does", () => {
    expect(ofBusiness("Maison Iris")).toBe("de Maison Iris");
    expect(ofBusiness("Atelier Lune")).toBe("d’Atelier Lune");
    expect(ofBusiness("Écrin")).toBe("d’Écrin");
  });
});

describe("the question", () => {
  it("two separate choices, never ticked in advance", () => {
    render(<Harness />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const box of boxes)
      expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("checkbox", { name: /par e-mail/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /par SMS/ })).toBeTruthy();
  });

  it("one ticked leaves the other alone", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("checkbox", { name: /par SMS/ }));
    expect(document.querySelector("output")!.textContent).toBe(
      JSON.stringify({ email: false, sms: true }),
    );
  });

  it("says it is optional, and that appointment messages are apart", () => {
    render(<Harness />);
    const group = screen.getByRole("group", { name: "Offres et nouveautés" });
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(group).getByText(CONSENT_WORDING.optional)).toBeTruthy();
    expect(within(group).getByText(CONSENT_WORDING.necessary)).toBeTruthy();
    expect(within(group).getByText(CONSENT_WORDING.withdraw)).toBeTruthy();
  });
});

describe("the history", () => {
  const event = (patch: Partial<ConsentEventDto>): ConsentEventDto => ({
    channel: "email",
    state: "granted",
    proofVersion: "mkt-fr-proposition-1",
    source: "booking",
    businessName: "Maison Iris",
    occurredAt: "2026-09-02T09:14:00Z",
    ...patch,
  });

  it("newest first, with date, channel, business and the wording's version", () => {
    render(
      <ConsentHistory
        events={[
          event({}),
          event({
            channel: "sms",
            state: "withdrawn",
            proofVersion: null,
            source: "unsubscribe_link",
            occurredAt: "2026-10-19T18:40:00Z",
          }),
        ]}
      />,
    );
    const items = within(
      screen.getByRole("list", { name: "Historique de ses choix" }),
    ).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("SMS : accord retiré");
    expect(items[0]!.textContent).toContain("depuis un message");
    expect(items[0]!.textContent).toContain("19 octobre 2026");
    expect(items[0]!.textContent).not.toContain("texte");
    expect(items[1]!.textContent).toContain("E-mail : accord donné");
    expect(items[1]!.textContent).toContain("Maison Iris");
    expect(items[1]!.textContent).toContain("mkt-fr-proposition-1");
  });

  it("nothing recorded: she receives no offers", () => {
    render(<ConsentHistory events={[]} />);
    expect(screen.getByText(/elle ne reçoit pas d’offres/)).toBeTruthy();
  });
});

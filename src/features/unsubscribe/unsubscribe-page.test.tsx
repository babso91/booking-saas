// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UnsubscribeActions } from "./contract";
import { memoryUnsubscribe } from "./memory-actions";
import { UnsubscribePage } from "./unsubscribe-page";

// The unsubscribe page against an in-memory server of the PROPOSED
// contract (docs/UNSUBSCRIBE_PROPOSAL.md).

afterEach(cleanup);

const press = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));

describe("unsubscribing", () => {
  it("opening the page changes nothing; her click does, for this business and channel only", async () => {
    const server = memoryUnsubscribe();
    render(<UnsubscribePage token="tok-a-email" actions={server.actions} />);
    await screen.findByText(
      /Vous ne recevrez plus les offres envoyées par e-mail par Atelier Maëlys/,
    );
    expect(server.writes).toBe(0);
    press("Ne plus recevoir ces offres");
    await screen.findByRole("heading", { name: "C’est fait" });
    expect(server.subject("tok-a-email")?.alreadyWithdrawn).toBe(true);
    expect(server.subject("tok-b-sms")?.alreadyWithdrawn).toBe(false);
    expect(document.body.textContent).toMatch(
      /Les rappels de vos rendez-vous continuent/,
    );
  });

  it("a mistake can be undone right away", async () => {
    const server = memoryUnsubscribe();
    render(<UnsubscribePage token="tok-a-email" actions={server.actions} />);
    await screen.findByRole("button", { name: "Ne plus recevoir ces offres" });
    press("Ne plus recevoir ces offres");
    await screen.findByRole("heading", { name: "C’est fait" });
    press("Annuler : continuer à recevoir les offres");
    await screen.findByRole("button", { name: "Ne plus recevoir ces offres" });
    expect(server.subject("tok-a-email")?.alreadyWithdrawn).toBe(false);
  });

  it("an unknown or forged link gets one opaque answer", async () => {
    render(
      <UnsubscribePage token="forged" actions={memoryUnsubscribe().actions} />,
    );
    await screen.findByText("Ce lien n’est plus valable");
    expect(document.body.textContent).not.toMatch(/Atelier|Studio/);
  });

  it("a failure says nothing changed", async () => {
    const server = memoryUnsubscribe();
    const withdraw = vi.fn<UnsubscribeActions["withdraw"]>(async () => ({
      ok: false,
      error: { code: "network" },
    }));
    render(
      <UnsubscribePage
        token="tok-a-email"
        actions={{ ...server.actions, withdraw }}
      />,
    );
    await screen.findByRole("button", { name: "Ne plus recevoir ces offres" });
    press("Ne plus recevoir ces offres");
    await screen.findByText("Ça n’a pas abouti");
    expect(server.subject("tok-a-email")?.alreadyWithdrawn).toBe(false);
  });
});

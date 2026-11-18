// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UnsubscribeActions } from "./contract";
import { memoryUnsubscribe } from "./memory-actions";
import { UnsubscribePage } from "./unsubscribe-page";

// The unsubscribe page against an in-memory server of the contract
// (docs/MARKETING_CONSENT_CONTRACT.md).

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

  it("offers no undo the server would refuse, and says why when it expires", async () => {
    const server = memoryUnsubscribe();
    render(<UnsubscribePage token="tok-a-email" actions={server.actions} />);
    await screen.findByRole("button", { name: "Ne plus recevoir ces offres" });
    press("Ne plus recevoir ces offres");
    await screen.findByRole("heading", { name: "C’est fait" });
    // The 30 minutes pass.
    server.subject("tok-a-email")!.canUndo = false;
    press("Annuler : continuer à recevoir les offres");
    expect(
      await screen.findByText(
        /Il n’est plus possible d’annuler depuis ce lien/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Annuler : continuer à recevoir les offres",
      }),
    ).toBeNull();
  });
});

describe("unsubscribeTokenFrom", () => {
  it("takes only a well-formed token from `#t=`", async () => {
    const { unsubscribeTokenFrom } = await import("./real-actions");
    const token = `uns_${"a".repeat(43)}`;
    expect(unsubscribeTokenFrom(`#t=${token}`)).toBe(token);
    expect(unsubscribeTokenFrom("#t=uns_short")).toBeNull();
    expect(unsubscribeTokenFrom("")).toBeNull();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeHostname, type SiteDomainActions } from "./contract";
import { DomainSettings } from "./domain-settings";
import { memorySiteDomain } from "./memory-actions";

// Her domain against an in-memory server of the PROPOSED contract
// (docs/SITE_DOMAIN_PROPOSAL.md). Nothing is resolved, bought or issued:
// the real guarantees (proof, generation, TLS, routing) are the backend's.

afterEach(cleanup);

const open = async (
  server = memorySiteDomain(),
  actions: SiteDomainActions = server.actions,
) => {
  render(<DomainSettings actions={actions} />);
  await screen.findByRole("heading", { name: "Mon domaine" });
  return server;
};
const press = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const link = async (host: string) => {
  fireEvent.change(screen.getByLabelText("Ton domaine"), {
    target: { value: host },
  });
  press("Relier ce domaine");
};

describe("the hostname", () => {
  it("normalized, never an address, path or port", () => {
    expect(normalizeHostname(" https://Salon-A.Example.test/reserver ")).toBe(
      "salon-a.example.test",
    );
    expect(normalizeHostname("salon-a.example.test.")).toBe(
      "salon-a.example.test",
    );
    expect(normalizeHostname("192.168.0.1")).toBeNull();
    expect(normalizeHostname("[::1]")).toBeNull();
    expect(normalizeHostname("salon.fr:8080")).toBeNull();
    expect(normalizeHostname("localhost")).toBeNull();
    expect(normalizeHostname("-salon.fr")).toBeNull();
  });

  it("an invalid one is said before anything is sent", async () => {
    const server = memorySiteDomain();
    const request = vi.fn(server.actions.request);
    await open(server, { ...server.actions, request });
    await link("192.168.0.1");
    expect(screen.getByText(/Un nom de domaine comme/)).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("the steps", () => {
  it("the recipe: not visible yet → exact TXT → certificate → active, the usual address always shown", async () => {
    await open();
    await link("salon-a.example.test");
    await screen.findByRole("region", { name: "État du domaine" });
    expect(screen.getByText("_reservation.salon-a.example.test")).toBeTruthy();
    expect(
      screen.getByText(/adresse habituelle reste toujours active/),
    ).toBeTruthy();
    press("Vérifier maintenant");
    await screen.findByText(/pas encore visible/);
    press("Vérifier maintenant");
    await screen.findByText(/certificat de sécurité est en cours d’émission/);
    expect(document.body.textContent).not.toMatch(/quelques minutes/);
    press("Vérifier le certificat");
    await screen.findByText("Ton domaine est actif");
    expect(
      screen.getByText(/adresse habituelle reste toujours active/),
    ).toBeTruthy();
  });

  it("a wrong proof and a failed certificate give their stable reason", async () => {
    await open(
      memorySiteDomain({ script: ["wrong_txt", "txt_ok", "tls_failed"] }),
    );
    await link("salon-a.example.test");
    await screen.findByRole("region", { name: "État du domaine" });
    press("Vérifier maintenant");
    await screen.findByText(/sa valeur ne correspond pas/);
    press("Vérifier maintenant");
    await screen.findByText(/en cours d’émission/);
    press("Vérifier le certificat");
    await screen.findByText(/certificat n’a pas pu être émis/);
  });

  it("a domain held by another site is refused by name", async () => {
    await open(memorySiteDomain({ taken: ["salon-a.example.test"] }));
    await link("salon-a.example.test");
    await screen.findByText(/déjà relié à un autre site/);
  });
});

describe("races and replays", () => {
  it("a proof expired: a new TXT value, said, the old one to replace", async () => {
    let clock = Date.parse("2026-11-14T10:00:00.000Z");
    const server = memorySiteDomain({ now: () => clock });
    await open(server);
    await link("salon-a.example.test");
    await screen.findByText("rsv-verif=g1-7f3a9c");
    clock += 49 * 3_600_000;
    press("Vérifier maintenant");
    await screen.findByText(/nouvelle valeur TXT a été générée/);
    await screen.findByText("rsv-verif=g2-7f3a9c");
  });

  it("a newer challenge elsewhere: the late check is refused, records read again", async () => {
    const server = await open();
    await link("salon-a.example.test");
    await screen.findByText("rsv-verif=g1-7f3a9c");
    server.bumpGeneration();
    press("Vérifier maintenant");
    await screen.findByText(/nouvelle vérification a été lancée ailleurs/);
    await screen.findByText("rsv-verif=g2-7f3a9c");
  });

  it("a lost answer is resent with the same request id: one check", async () => {
    const server = memorySiteDomain();
    let lose = true;
    const retry = vi.fn<SiteDomainActions["retry"]>(async (input) => {
      const result = await server.actions.retry(input);
      if (lose) {
        lose = false;
        return { ok: false, error: { code: "network" } };
      }
      return result;
    });
    await open(server, { ...server.actions, retry });
    await link("salon-a.example.test");
    await screen.findByRole("region", { name: "État du domaine" });
    press("Vérifier maintenant");
    await screen.findByText(/Pas de réponse/);
    press("Vérifier maintenant");
    await screen.findByText(/pas encore visible/);
    expect(retry.mock.calls[0]?.[0].requestId).toBe(
      retry.mock.calls[1]?.[0].requestId,
    );
    // The next click is a new check.
    press("Vérifier maintenant");
    await screen.findByText(/en cours d’émission/);
    expect(retry.mock.calls[2]?.[0].requestId).not.toBe(
      retry.mock.calls[1]?.[0].requestId,
    );
  });

  it("detaching is confirmed; the usual address stays", async () => {
    await open();
    await link("salon-a.example.test");
    await screen.findByRole("region", { name: "État du domaine" });
    press("Délier ce domaine");
    expect(
      screen.getByText(/ton adresse habituelle continue de fonctionner/),
    ).toBeTruthy();
    press("Délier le domaine");
    await screen.findByText(/n’est plus relié à ton site/);
    expect(screen.getByLabelText("Ton domaine")).toBeTruthy();
  });
});

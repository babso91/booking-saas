// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { ClientHubAccessDto } from "@/features/client-hub/types";
import type { ActionResult } from "@/lib/errors";

import { deferred } from "../testing/fake-api";
import { ClientHubAccess } from "./client-hub-access";

const actions = vi.hoisted(() => ({
  getClientHubAccessAction: vi.fn(),
  setClientHubAccessAction: vi.fn(),
}));
vi.mock("@/features/client-hub/actions/access", () => actions);

const CLIENT = "20000000-0000-4000-8000-000000000001";
const granted = (email: string): ClientHubAccessDto => ({
  clientId: CLIENT,
  granted: true,
  email,
  grantedAt: "2026-10-20T09:00:00Z",
});
const none: ClientHubAccessDto = {
  clientId: CLIENT,
  granted: false,
  email: null,
  grantedAt: null,
};
const done = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const refused = (code: string): ActionResult<never> =>
  ({
    ok: false,
    error: { code, message: "backend text" },
  }) as ActionResult<never>;

let onStale: Mock<() => void>;
let onEditClient: Mock<() => void>;

beforeEach(() => {
  actions.getClientHubAccessAction.mockReset().mockResolvedValue(done(none));
  actions.setClientHubAccessAction.mockReset();
  onStale = vi.fn<() => void>();
  onEditClient = vi.fn<() => void>();
});

function card(email: string | null = "camille@exemple.fr") {
  return (
    <ClientHubAccess
      clientId={CLIENT}
      email={email}
      displayName="Camille Martin"
      timezone="Europe/Paris"
      onEditClient={onEditClient}
      onStale={onStale}
    />
  );
}

async function grant() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Autoriser l’accès" }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Autoriser l’accès" }),
  );
}

describe("Client Hub access on the CRM record", () => {
  it("is never granted by itself: reading the record only reads the access", async () => {
    render(card());
    expect(await screen.findByText("Non autorisé")).toBeTruthy();
    expect(actions.getClientHubAccessAction).toHaveBeenCalledWith({
      clientId: CLIENT,
    });
    expect(actions.setClientHubAccessAction).not.toHaveBeenCalled();
  });

  it("grants for the address shown (expectedEmail), after a confirmation, and shows the address the backend vouched for", async () => {
    actions.setClientHubAccessAction.mockResolvedValue(
      done(granted("camille@exemple.fr")),
    );
    render(card("Camille@Exemple.fr"));
    await grant();
    expect(actions.setClientHubAccessAction).toHaveBeenCalledWith({
      clientId: CLIENT,
      granted: true,
      expectedEmail: "Camille@Exemple.fr",
    });
    expect(await screen.findByText("Accès autorisé")).toBeTruthy();
    expect(screen.getByText("camille@exemple.fr")).toBeTruthy();
    expect(
      screen.getByText(/Accès ouvert pour camille@exemple.fr/),
    ).toBeTruthy();
    // No invitation exists: none is claimed.
    expect(document.body.textContent).toMatch(
      /Aucune invitation n’est envoyée/,
    );
    expect(document.body.textContent).not.toMatch(
      /invitation (a été )?envoyée/,
    );
  });

  it("the confirmation says what she will and will not see", async () => {
    render(card());
    fireEvent.click(
      await screen.findByRole("button", { name: "Autoriser l’accès" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/réservations faites avant aujourd’hui/);
    expect(dialog.textContent).toMatch(/Jamais tes notes/);
    expect(dialog.textContent).toContain("camille@exemple.fr");
  });

  it("revokes after a confirmation", async () => {
    actions.getClientHubAccessAction.mockResolvedValue(
      done(granted("camille@exemple.fr")),
    );
    actions.setClientHubAccessAction.mockResolvedValue(done(none));
    render(card());
    fireEvent.click(
      await screen.findByRole("button", { name: "Retirer l’accès" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/même si elle est déjà connectée/);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Retirer l’accès" }),
    );
    await waitFor(() =>
      expect(actions.setClientHubAccessAction).toHaveBeenCalledWith({
        clientId: CLIENT,
        granted: false,
      }),
    );
    expect(await screen.findByText("Non autorisé")).toBeTruthy();
    expect(screen.getByText(/Accès retiré/)).toBeTruthy();
  });

  it("the record's email changed meanwhile (stale_client): refused, nothing granted, the record and the access read again", async () => {
    actions.setClientHubAccessAction.mockResolvedValue(refused("stale_client"));
    render(card());
    await grant();
    expect(
      await screen.findByText(
        /L’email de la fiche a changé entre-temps\. La fiche vient d’être relue/,
      ),
    ).toBeTruthy();
    // Said once, and never "reload it": it is already being read again.
    expect(document.body.textContent).not.toMatch(/Recharge-la/);
    expect(onStale).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(actions.getClientHubAccessAction).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByText("Non autorisé")).toBeTruthy();
  });

  it("a change of the record's email: the access is read again, and its automatic revocation is said", async () => {
    actions.getClientHubAccessAction.mockResolvedValue(
      done(granted("camille@exemple.fr")),
    );
    const { rerender } = render(card("camille@exemple.fr"));
    expect(await screen.findByText("Accès autorisé")).toBeTruthy();
    actions.getClientHubAccessAction.mockResolvedValue(done(none));
    rerender(card("camille.martin@exemple.fr"));
    expect(
      await screen.findByText(
        /l’accès accordé à camille@exemple.fr a été retiré automatiquement/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Non autorisé")).toBeTruthy();
    expect(screen.getByText("camille.martin@exemple.fr")).toBeTruthy();
  });

  it("a late read for the previous email never replaces the newer one", async () => {
    const late = deferred<ActionResult<ClientHubAccessDto>>();
    actions.getClientHubAccessAction.mockReturnValueOnce(late.promise);
    const { rerender } = render(card("ancienne@exemple.fr"));
    actions.getClientHubAccessAction.mockResolvedValue(done(none));
    rerender(card("nouvelle@exemple.fr"));
    expect(await screen.findByText("Non autorisé")).toBeTruthy();
    await act(async () => {
      late.resolve(done(granted("ancienne@exemple.fr")));
    });
    expect(screen.queryByText("Accès autorisé")).toBeNull();
    expect(screen.queryByText("ancienne@exemple.fr")).toBeNull();
  });

  it("a grant answering after the record was read again (email changed) is not trusted: read again", async () => {
    const held = deferred<ActionResult<ClientHubAccessDto>>();
    actions.setClientHubAccessAction.mockReturnValue(held.promise);
    const { rerender } = render(card("a@exemple.fr"));
    await grant();
    rerender(card("b@exemple.fr"));
    await act(async () => {
      held.resolve(done(granted("a@exemple.fr")));
    });
    await waitFor(() =>
      expect(actions.getClientHubAccessAction).toHaveBeenCalledTimes(3),
    );
    expect(await screen.findByText("Non autorisé")).toBeTruthy();
    expect(screen.queryByText("Accès autorisé")).toBeNull();
  });

  it("no answer to a grant: never shown as done or failed, the access is read again", async () => {
    actions.setClientHubAccessAction.mockRejectedValue(
      new TypeError("fetch failed"),
    );
    render(card());
    await grant();
    expect(await screen.findByText(/a peut-être été enregistré/)).toBeTruthy();
    await waitFor(() =>
      expect(actions.getClientHubAccessAction).toHaveBeenCalledTimes(2),
    );
  });

  it("without email: nothing to grant, the way to add one", async () => {
    render(card(null));
    expect(await screen.findByText(/Ajoute une adresse email/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Autoriser l’accès" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ajouter un email" }));
    expect(onEditClient).toHaveBeenCalled();
  });

  it("a granted address that differs from the one shown is flagged, with a way to reload", async () => {
    actions.getClientHubAccessAction.mockResolvedValue(
      done(granted("autre@exemple.fr")),
    );
    render(card("camille@exemple.fr"));
    expect(
      await screen.findByText(/autorisé pour une autre adresse/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recharger la fiche" }));
    expect(onStale).toHaveBeenCalled();
  });

  it("a failed read says so and can be retried", async () => {
    actions.getClientHubAccessAction.mockResolvedValueOnce(refused("internal"));
    render(card());
    expect(await screen.findByText(/n’a pas pu être chargé/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByText("Non autorisé")).toBeTruthy();
  });
});

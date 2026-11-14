// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TeamActions } from "./contract";
import { memoryTeam } from "./memory-actions";
import { TeamManager } from "./team-manager";

// The team screen against an in-memory server of the PROPOSED contract
// (docs/TEAM_PROPOSAL.md): what it shows, sends and keeps. The real
// guarantees (roles, tenant, invitation tokens) are the backend's.

afterEach(cleanup);

const open = async (
  server = memoryTeam(),
  actions: TeamActions = server.actions,
) => {
  render(<TeamManager actions={actions} />);
  await screen.findByRole("heading", { name: "Équipe" });
  return server;
};
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const dialog = () => within(screen.getByRole("dialog"));

describe("the team list", () => {
  it("keeps bookable and access apart, and says where an invitation stands", async () => {
    await open();
    const list = within(screen.getByRole("list", { name: /Membres/ }));
    const [owner, ines] = list.getAllByRole("listitem") as [
      HTMLElement,
      HTMLElement,
    ];
    expect(within(owner).getByText("Propriétaire")).toBeTruthy();
    expect(within(ines).getByText("Réservable")).toBeTruthy();
    expect(within(ines).getByText("Sans accès au logiciel")).toBeTruthy();
    expect(ines.textContent).toMatch(
      /Invitation en attente pour ines@exemple\.fr, valable jusqu’au 21 novembre/,
    );
    expect(ines.textContent).toMatch(/Motif au henné/);
  });

  it("a failed read says so, changes nothing, and can be retried", async () => {
    const server = memoryTeam();
    const read = vi
      .fn<TeamActions["read"]>()
      .mockResolvedValueOnce({ ok: false, error: { code: "network" } })
      .mockImplementation(server.actions.read);
    render(<TeamManager actions={{ ...server.actions, read }} />);
    await screen.findByText("L’équipe n’a pas pu être chargée");
    click("Réessayer");
    await screen.findByRole("heading", { name: "Équipe" });
  });
});

describe("a profile", () => {
  it("a bookable profile is created without any account or email", async () => {
    const server = await open();
    click("Ajouter une personne");
    type("Nom affiché à tes clientes", "Sarah");
    fireEvent.click(dialog().getByLabelText("Épilation jambes"));
    fireEvent.click(
      dialog().getByRole("button", { name: "Ajouter à l’équipe" }),
    );
    await screen.findByText("Sarah est enregistrée.");
    const sarah = server.state.members.find((m) => m.displayName === "Sarah");
    expect(sarah).toMatchObject({
      bookable: true,
      serviceIds: ["s-wax"],
      access: null,
      invite: null,
    });
  });

  it("an empty name is said, nothing is sent", async () => {
    const server = memoryTeam();
    const createStaff = vi.fn(server.actions.createStaff);
    await open(server, { ...server.actions, createStaff });
    click("Ajouter une personne");
    fireEvent.click(
      dialog().getByRole("button", { name: "Ajouter à l’équipe" }),
    );
    expect(dialog().getByText("Indique son prénom ou son nom.")).toBeTruthy();
    expect(createStaff).not.toHaveBeenCalled();
  });

  it("a lost answer is resent with the same operation id: applied once", async () => {
    const server = memoryTeam();
    let lose = true;
    const createStaff: TeamActions["createStaff"] = async (input) => {
      const result = await server.actions.createStaff(input);
      if (lose) {
        lose = false;
        return { ok: false, error: { code: "network" } };
      }
      return result;
    };
    const spy = vi.fn(createStaff);
    await open(server, { ...server.actions, createStaff: spy });
    click("Ajouter une personne");
    type("Nom affiché à tes clientes", "Sarah");
    const add = () =>
      fireEvent.click(
        dialog().getByRole("button", { name: "Ajouter à l’équipe" }),
      );
    add();
    await dialog().findByText(/Pas de réponse/);
    add();
    await screen.findByText("Sarah est enregistrée.");
    expect(spy.mock.calls[0]?.[0].operationId).toBe(
      spy.mock.calls[1]?.[0].operationId,
    );
    expect(
      server.state.members.filter((m) => m.displayName === "Sarah"),
    ).toHaveLength(1);
  });

  it("changed elsewhere: her typing stays, the next save uses the new revision", async () => {
    const server = await open();
    click("Gérer Inès");
    type("Nom affiché à tes clientes", "Inès B.");
    // Someone else saves Inès meanwhile.
    server.state.members[1] = {
      ...server.state.members[1]!,
      revision: 3,
      displayName: "Inès (autre)",
    };
    fireEvent.click(dialog().getByRole("button", { name: "Enregistrer" }));
    await dialog().findByText(/Ce profil a changé ailleurs/);
    expect(
      (
        dialog().getByLabelText(
          "Nom affiché à tes clientes",
        ) as HTMLInputElement
      ).value,
    ).toBe("Inès B.");
    await waitFor(() =>
      expect(screen.getAllByText("Inès (autre)").length).toBeGreaterThan(0),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Enregistrer" }));
    await screen.findByText("Inès B. est enregistrée.");
    expect(server.state.members[1]).toMatchObject({
      displayName: "Inès B.",
      revision: 4,
    });
  });

  it("no longer bookable with appointments ahead: warned, then refused by name", async () => {
    await open();
    click("Gérer Inès");
    fireEvent.click(
      dialog().getByRole("switch", { name: "Peut recevoir des rendez-vous" }),
    );
    expect(dialog().getByText(/3 rendez-vous à venir/)).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Enregistrer" }));
    await dialog().findByText(/déplace-les d’abord/);
  });
});

describe("access to the software", () => {
  it("an invitation is resent with the chosen role", async () => {
    const server = await open();
    click("Gérer Inès");
    expect(
      dialog().getByText(/La renvoyer rend l’ancienne inutilisable/),
    ).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Administratrice" }));
    fireEvent.click(
      dialog().getByRole("button", { name: "Renvoyer l’invitation" }),
    );
    await screen.findByText("Invitation enregistrée pour ines@exemple.fr.");
    expect(server.state.members[1]?.invite).toMatchObject({
      status: "pending",
      role: "admin",
    });
  });

  it("an invalid email is said before anything is sent", async () => {
    const server = memoryTeam();
    const sendInvite = vi.fn(server.actions.sendInvite);
    await open(server, { ...server.actions, sendInvite });
    click("Gérer Inès");
    type("Son email", "ines@");
    fireEvent.click(
      dialog().getByRole("button", { name: "Renvoyer l’invitation" }),
    );
    expect(dialog().getByText("Une adresse email valide.")).toBeTruthy();
    expect(sendInvite).not.toHaveBeenCalled();
  });

  it("the last owner's access cannot be removed: the server's refusal is said", async () => {
    await open();
    click("Gérer Maëlys");
    fireEvent.click(dialog().getByRole("button", { name: "Retirer l’accès" }));
    expect(
      dialog().getByText(/Son profil et ses rendez-vous restent/),
    ).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Retirer l’accès" }));
    await dialog().findByText(/seule propriétaire/);
  });
});

describe("on the real backend, before any email transport", () => {
  it("no invitation is offered, so none can stay unanswered; access can still be removed", async () => {
    const server = memoryTeam();
    render(<TeamManager actions={server.actions} invitations="not_sent_yet" />);
    await screen.findByRole("heading", { name: "Équipe" });
    click("Gérer Inès");
    expect(
      dialog().getByText(/Les invitations par e-mail arrivent/),
    ).toBeTruthy();
    expect(dialog().queryByLabelText("Son email")).toBeNull();
    expect(dialog().queryByRole("button", { name: /invitation/i })).toBeNull();
  });

  it("a pending invitation is described as pending, never as sent", async () => {
    await open();
    expect(document.body.textContent).toMatch(
      /Invitation en attente pour ines@exemple\.fr/,
    );
    expect(document.body.textContent).not.toMatch(/Invitation envoyée/);
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TeamJoin } from "./team-join";

// The team invitation page, each situation of docs/TEAM_CONTRACT.md
// (« Rejoindre l'équipe »), with the Server Actions mocked at their
// boundary. What the server proves (password, sessions) is its own tests'.

const { actions, router } = vi.hoisted(() => ({
  actions: {
    acceptTeamInviteAction: vi.fn(),
    completeTeamInviteAction: vi.fn(),
  },
  router: { replace: vi.fn() },
}));
vi.mock("@/features/team/actions/team", () => ({
  acceptTeamInviteAction: (...args: unknown[]) =>
    actions.acceptTeamInviteAction(...args),
  completeTeamInviteAction: (...args: unknown[]) =>
    actions.completeTeamInviteAction(...args),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const TOKEN = `team_${"a".repeat(43)}`;
const fail = (code: string) => ({
  ok: false as const,
  error: { code, message: "never shown" },
});

beforeEach(() => {
  Object.values(actions).forEach((mock) => mock.mockReset());
  router.replace.mockReset();
});
afterEach(cleanup);

describe("TeamJoin", () => {
  it("without a session or a token, asks nothing and says the link is incomplete", () => {
    render(<TeamJoin token={null} signedIn={false} />);
    expect(
      screen.getByRole("heading", { name: "Ce lien est incomplet" }),
    ).toBeTruthy();
    expect(actions.acceptTeamInviteAction).not.toHaveBeenCalled();
  });

  it("without a session, leads to sign-up or sign-in with the token", () => {
    render(<TeamJoin token={TOKEN} signedIn={false} />);
    expect(
      screen
        .getByRole("link", { name: "Créer mon compte" })
        .getAttribute("href"),
    ).toBe(`/signup?invitation=${TOKEN}`);
    expect(
      screen
        .getByRole("link", { name: "J’ai déjà un compte" })
        .getAttribute("href"),
    ).toBe(`/login?invitation=${TOKEN}`);
    expect(window.location.pathname + window.location.search).not.toContain(
      TOKEN,
    );
  });

  it("signed in, joins only on her tap, then goes to the agenda", async () => {
    actions.acceptTeamInviteAction.mockResolvedValue({
      ok: true,
      data: { businessId: "b1", next: "/app" },
    });
    render(<TeamJoin token={TOKEN} signedIn />);
    expect(actions.acceptTeamInviteAction).not.toHaveBeenCalled();
    expect(screen.getByText(/tes autres sessions ouvertes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rejoindre l’équipe" }));
    expect(await screen.findByText("Équipe rejointe")).toBeTruthy();
    expect(actions.acceptTeamInviteAction).toHaveBeenCalledWith({
      token: TOKEN,
    });
  });

  it("asked for her password, sends her own, then joins", async () => {
    actions.acceptTeamInviteAction.mockResolvedValue(
      fail("invitation_password_required"),
    );
    actions.completeTeamInviteAction.mockResolvedValue({
      ok: true,
      data: { businessId: "b1", next: "/app" },
    });
    render(<TeamJoin token={null} signedIn />);
    fireEvent.click(screen.getByRole("button", { name: "Rejoindre l’équipe" }));
    const field = await screen.findByLabelText("Nouveau mot de passe");
    fireEvent.change(field, { target: { value: "un-mot-de-passe-long" } });
    fireEvent.click(screen.getByRole("button", { name: "Rejoindre l’équipe" }));
    expect(await screen.findByText("Équipe rejointe")).toBeTruthy();
    expect(actions.completeTeamInviteAction).toHaveBeenCalledWith({
      password: "un-mot-de-passe-long",
    });
  });

  it("says a refused invitation plainly", async () => {
    actions.acceptTeamInviteAction.mockResolvedValue(
      fail("invitation_email_mismatch"),
    );
    render(<TeamJoin token={TOKEN} signedIn />);
    fireEvent.click(screen.getByRole("button", { name: "Rejoindre l’équipe" }));
    expect(await screen.findByText("Autre adresse")).toBeTruthy();
  });
});

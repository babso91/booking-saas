// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/features/agenda/components/app-shell";
import {
  defaultAppearancePreferences,
  importDeviceAppearanceSchema,
  savePreferencesSchema,
  type AppearanceChanges,
  type AppearancePreferences,
} from "@/features/preferences/model";
import type { AreaPreferences } from "@/features/preferences/server/area-preferences";

import { router } from "../../../../tests/support/next-router";
import { AccountAppearanceProvider } from "./appearance-provider";
import { AppearanceSettings } from "./appearance-settings";

// The Apparence page in its frame, on the real provider and state machine,
// with only the Server Actions replaced: what she does, and what is sent.

const actions = vi.hoisted(() => ({
  getMyPreferencesAction: vi.fn(),
  saveMyPreferencesAction: vi.fn(),
  importDeviceAppearanceAction: vi.fn(),
}));
const path = vi.hoisted(() => ({ current: "/app/settings/appearance" }));

vi.mock("@/features/preferences/actions/preferences", () => actions);
vi.mock("next/navigation", async () => ({
  ...(await import("../../../../tests/support/next-router")).nextNavigationMock,
  usePathname: () => path.current,
}));
vi.mock("@/features/auth/actions/auth", () => ({ signOutAction: vi.fn() }));

const uuid = (name: string) =>
  `00000000-0000-4000-8000-${name.padStart(12, "0")}`;
const M1 = uuid("1");
const M2 = uuid("2");
const context = (membershipId = M1) => ({
  userId: uuid("99"),
  businessId: uuid("b1"),
  membershipId,
});
const onWire = () => ({ businessId: uuid("b1"), membershipId: M1 });

function area(
  appearance: AppearanceChanges = {},
  version = 0,
  membershipId = M1,
  offer: AppearancePreferences | null = null,
): AreaPreferences {
  const look = { ...defaultAppearancePreferences, ...appearance };
  return {
    snapshot: {
      context: context(membershipId),
      preferences: {
        incarnation: version ? uuid("a1") : null,
        version,
        appearance: look,
      },
    },
    appearance: look,
    source: "account",
    deviceAppearanceOffer: offer,
  };
}

const answer = (appearance: AppearanceChanges, version: number) => ({
  ok: true,
  data: {
    status: "saved",
    context: context(),
    preferences: {
      incarnation: uuid("a1"),
      version,
      appearance: { ...defaultAppearancePreferences, ...appearance },
    },
  },
});

/** A save the test answers when it says so. */
function holdSave() {
  let release!: (value: unknown) => void;
  actions.saveMyPreferencesAction.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  return (value: unknown) =>
    act(async () => {
      release(value);
    });
}

const Page = ({ of }: { of: AreaPreferences }) => (
  <AccountAppearanceProvider area={of}>
    <AppShell
      business={{ name: "Atelier Maëlys", slug: "atelier-maelys" }}
      current="appearance"
    >
      <AppearanceSettings />
    </AppShell>
  </AccountAppearanceProvider>
);

const style = () => document.documentElement.getAttribute("data-style");
const radio = (name: RegExp) => screen.getByRole("radio", { name });
const said = () =>
  screen
    .getAllByRole("status")
    .map((status) => status.textContent)
    .join(" ");

beforeEach(() => {
  path.current = "/app/settings/appearance";
  vi.clearAllMocks();
  window.history.pushState({}, "", "/app/settings/appearance");
  document.cookie = "dash_appearance=; Max-Age=0; Path=/app";
});
afterEach(cleanup);

describe("the first render", () => {
  it.each([
    ["ecrin", "ecrin"],
    ["studio", "studio"],
    ["classique", "classique"],
    // Accepted by the account, not delivered yet: Classique, account untouched.
    ["carnet", "classique"],
  ] as const)("account in %s: the server already draws %s", (held, drawn) => {
    const html = renderToString(<Page of={area({ style: held }, 2)} />);
    expect(html).toContain(`data-style="${drawn}"`);
    expect(actions.saveMyPreferencesAction).not.toHaveBeenCalled();
  });

  it("does not offer Carnet", () => {
    render(<Page of={area({ style: "carnet" }, 2)} />);
    expect(screen.queryAllByRole("radio", { name: /Carnet/ })).toEqual([]);
    expect(radio(/^Classique/)).toHaveProperty("checked", true);
  });
});

describe("choosing", () => {
  it("applies at once, says it is saving, then that it is saved", async () => {
    const user = userEvent.setup();
    const release = holdSave();
    render(<Page of={area()} />);
    await user.click(radio(/^Écrin/));

    expect(style()).toBe("ecrin");
    expect(document.activeElement).toBe(radio(/^Écrin/));
    expect(said()).toContain("Enregistrement…");
    expect(actions.saveMyPreferencesAction).toHaveBeenCalledWith({
      context: onWire(),
      expected: { incarnation: null, version: 0 },
      changes: { style: "ecrin" },
    });
    savePreferencesSchema.parse(
      actions.saveMyPreferencesAction.mock.lastCall![0],
    );

    await release(answer({ style: "ecrin" }, 1));
    expect(said()).toContain("Enregistré sur ton compte.");
  });

  it("every setting reaches the account: ambiance, mode, accent, animations", async () => {
    const user = userEvent.setup();
    actions.saveMyPreferencesAction.mockResolvedValue(answer({}, 1));
    render(<Page of={area()} />);
    const sent = () =>
      actions.saveMyPreferencesAction.mock.lastCall![0].changes;

    await user.click(radio(/^Lin/));
    expect(sent()).toMatchObject({ ambiance: "lin" });
    await user.click(radio(/^Sombre/));
    expect(sent()).toMatchObject({ mode: "dark" });
    await user.click(radio(/^Aucune/));
    expect(sent()).toMatchObject({ motion: "none" });
  });

  it("an account in Carnet: another setting changes that one only", async () => {
    const user = userEvent.setup();
    actions.saveMyPreferencesAction.mockResolvedValue(answer({}, 3));
    render(<Page of={area({ style: "carnet", accent: "#112233" }, 2)} />);
    expect(style()).toBe("classique");
    await user.click(radio(/^Sombre/));
    expect(actions.saveMyPreferencesAction.mock.lastCall![0].changes).toEqual({
      mode: "dark",
    });
  });

  it("not answered: says so, keeps her choice, sends it again by itself", async () => {
    const user = userEvent.setup();
    actions.saveMyPreferencesAction.mockRejectedValueOnce(new Error("offline"));
    render(<Page of={area()} />);
    await user.click(radio(/^Sombre/));
    await vi.waitFor(() => expect(said()).toContain("Pas encore enregistré"));
    expect(radio(/^Sombre/)).toHaveProperty("checked", true);

    actions.saveMyPreferencesAction.mockResolvedValue(
      answer({ mode: "dark" }, 1),
    );
    await vi.waitFor(
      () => expect(said()).toContain("Enregistré sur ton compte."),
      { timeout: 3_000 },
    );
  });

  it("warns before leaving only while something is not saved", async () => {
    const user = userEvent.setup();
    const release = holdSave();
    render(<Page of={area()} />);
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    await user.click(radio(/^Sombre/));
    expect(leave()).toBe(true);
    await release(answer({ mode: "dark" }, 1));
    expect(leave()).toBe(false);
  });
});

describe("renders of the layout", () => {
  it("router.refresh() during a save erases nothing and reads nothing", async () => {
    const user = userEvent.setup();
    const release = holdSave();
    const { rerender } = render(<Page of={area()} />);
    await user.click(radio(/^Écrin/));

    rerender(<Page of={area({ style: "studio" }, 1)} />);
    expect(style()).toBe("ecrin");
    expect(said()).toContain("Enregistrement…");
    expect(actions.getMyPreferencesAction).not.toHaveBeenCalled();

    await release(answer({ style: "ecrin" }, 2));
    expect(style()).toBe("ecrin");
  });

  it("another context: its own look, and the save on its way is forgotten", async () => {
    const user = userEvent.setup();
    const release = holdSave();
    const { rerender } = render(<Page of={area()} />);
    await user.click(radio(/^Écrin/));

    rerender(<Page of={area({ style: "studio" }, 4, M2)} />);
    expect(style()).toBe("studio");

    await release(answer({ style: "ecrin" }, 1));
    expect(style()).toBe("studio");
    expect(said()).not.toContain("Enregistr");
    expect(actions.saveMyPreferencesAction).toHaveBeenCalledTimes(1);
  });
});

describe("coming back to the tab", () => {
  it("focus and visibilitychange together make one read; its news is shown", async () => {
    actions.getMyPreferencesAction.mockResolvedValue({
      ok: true,
      data: {
        context: context(),
        preferences: {
          incarnation: uuid("a1"),
          version: 3,
          appearance: { ...defaultAppearancePreferences, mode: "dark" },
        },
      },
    });
    render(<Page of={area({}, 2)} />);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(actions.getMyPreferencesAction).toHaveBeenCalledTimes(1);
    expect(radio(/^Sombre/)).toHaveProperty("checked", true);
  });

  it("her account moved to Classique while on « Aujourd’hui »: back to the agenda", async () => {
    path.current = "/app/today";
    actions.getMyPreferencesAction.mockResolvedValue({
      ok: true,
      data: {
        context: context(),
        preferences: {
          incarnation: uuid("a1"),
          version: 3,
          appearance: defaultAppearancePreferences,
        },
      },
    });
    render(<Page of={area({ style: "studio" }, 2)} />);
    expect(router.replace).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(router.replace).toHaveBeenCalledWith("/app");
  });
});

describe("the account could not be read", () => {
  const away = (): AreaPreferences => ({
    snapshot: null,
    appearance: { ...defaultAppearancePreferences, style: "studio" },
    source: "device",
    deviceAppearanceOffer: null,
  });

  it("shows what it can, says so, and nothing can be changed or saved", async () => {
    actions.getMyPreferencesAction.mockResolvedValue({
      ok: false,
      error: { code: "internal", message: "x" },
    });
    render(<Page of={away()} />);
    expect(style()).toBe("studio");
    expect(screen.getByText(/Ton compte ne répond pas/)).toBeTruthy();
    expect(radio(/^Écrin/).matches(":disabled")).toBe(true);
    await act(async () => undefined);
    expect(actions.saveMyPreferencesAction).not.toHaveBeenCalled();
  });

  it("a read that answers gives the page her account back", async () => {
    actions.getMyPreferencesAction.mockResolvedValue({
      ok: true,
      data: area({ style: "ecrin" }, 2).snapshot,
    });
    render(<Page of={away()} />);
    await act(async () => undefined);
    expect(style()).toBe("ecrin");
    expect(radio(/^Studio/).matches(":disabled")).toBe(false);
  });
});

describe("an old device's look", () => {
  const look = {
    ...defaultAppearancePreferences,
    style: "ecrin" as const,
    mode: "dark" as const,
  };
  const question = () =>
    screen.queryByRole("region", {
      name: "Garder cette apparence sur votre compte ?",
    });

  beforeEach(() => {
    document.cookie =
      "dash_appearance=atelier.dark.standard.-.ecrin; Path=/app";
    actions.getMyPreferencesAction.mockResolvedValue({
      ok: true,
      data: area(look, 1).snapshot,
    });
  });

  it("is asked, says what it is, and changes nothing without her answer", () => {
    render(<Page of={area({}, 0, M1, look)} />);
    expect(question()!.textContent).toContain("Écrin, sombre");
    expect(style()).toBe("classique");
    expect(actions.importDeviceAppearanceAction).not.toHaveBeenCalled();
    expect(actions.saveMyPreferencesAction).not.toHaveBeenCalled();
  });

  it("kept: imported for this context, shown from a read, not asked again", async () => {
    const user = userEvent.setup();
    actions.importDeviceAppearanceAction.mockResolvedValue(answer(look, 1));
    render(<Page of={area({}, 0, M1, look)} />);
    await user.click(
      within(question()!).getByRole("button", { name: "Garder" }),
    );
    expect(actions.importDeviceAppearanceAction).toHaveBeenCalledWith({
      context: onWire(),
      appearance: look,
    });
    importDeviceAppearanceSchema.parse(
      actions.importDeviceAppearanceAction.mock.lastCall![0],
    );
    await vi.waitFor(() => expect(style()).toBe("ecrin"));
    expect(question()).toBeNull();
    expect(document.cookie).not.toContain("dash_appearance");
  });

  it("declined: nothing is sent, the device forgets it", async () => {
    const user = userEvent.setup();
    render(<Page of={area({}, 0, M1, look)} />);
    await user.click(
      within(question()!).getByRole("button", { name: "Non merci" }),
    );
    expect(question()).toBeNull();
    expect(style()).toBe("classique");
    expect(actions.importDeviceAppearanceAction).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain("dash_appearance");
  });

  it("not answered: asked still, with what happened", async () => {
    const user = userEvent.setup();
    actions.importDeviceAppearanceAction.mockRejectedValue(new Error("x"));
    render(<Page of={area({}, 0, M1, look)} />);
    await user.click(
      within(question()!).getByRole("button", { name: "Garder" }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(question()).not.toBeNull();
    expect(style()).toBe("classique");
    expect(document.cookie).toContain("dash_appearance");
  });

  it("she chose something herself meanwhile: the question goes", async () => {
    const user = userEvent.setup();
    actions.saveMyPreferencesAction.mockResolvedValue(
      answer({ mode: "dark" }, 1),
    );
    render(<Page of={area({}, 0, M1, look)} />);
    await user.click(radio(/^Sombre/));
    await vi.waitFor(() => expect(question()).toBeNull());
  });
});

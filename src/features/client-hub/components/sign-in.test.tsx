// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  B1,
  business,
  deferred,
  fail,
  fakeApi,
  ok,
  profile,
} from "../testing/fake-api";
import { HubRoot } from "./hub-shell";
import { ATTEMPTS, SignIn } from "./sign-in";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const CHALLENGE = "c0ffee00-0000-4000-8000-000000000001";
const SECOND = "c0ffee00-0000-4000-8000-000000000002";
const inTen = () => new Date(Date.now() + 10 * 60_000).toISOString();

let api: ReturnType<typeof fakeApi>;
let signedIn: boolean;

beforeEach(() => {
  router.replace.mockReset();
  signedIn = false;
  api = fakeApi()
    .on("GET", /\/me$/, () =>
      signedIn
        ? ok(profile("camille@exemple.fr", [business(B1, "Studio Mila")]))
        : fail("client_hub_unauthenticated", 401),
    )
    .on("POST", /\/session\/code$/, () =>
      ok({ challengeId: CHALLENGE, expiresAt: inTen() }, 202),
    )
    .on("POST", /\/session\/verify$/, (call) => {
      const body = call.body as { code: string };
      if (body.code !== "12345678") return fail("client_hub_code_invalid", 400);
      signedIn = true;
      return ok({ email: "camille@exemple.fr", expiresAt: inTen() });
    })
    .install();
});

afterEach(() => {
  vi.useRealTimers();
});

function renderSignIn() {
  // The real root of /espace: session and screens remounted per identity.
  return render(
    <HubRoot>
      <SignIn />
    </HubRoot>,
  );
}

async function askCode(
  user: ReturnType<typeof userEvent.setup>,
  email = "camille@exemple.fr",
) {
  await user.type(await screen.findByLabelText("Adresse email"), email);
  await user.click(screen.getByRole("button", { name: "Recevoir mon code" }));
  return screen.findByLabelText("Code à 8 chiffres");
}

describe("asking for a code", () => {
  it("sends the address as JSON and moves to the code, naming the address", async () => {
    const user = userEvent.setup();
    renderSignIn();
    await askCode(user, "  camille@exemple.fr ");

    const [call] = api.to(/\/session\/code$/, "POST");
    expect(call!.body).toEqual({ email: "camille@exemple.fr" });
    expect(call!.headers.get("content-type")).toBe("application/json");
    expect(call!.init.credentials).toBe("same-origin");
    expect(call!.init.cache).toBe("no-store");
    expect(screen.getByText("camille@exemple.fr")).toBeTruthy();
  });

  it("says the same thing for any address: nothing tells whether it is known", async () => {
    const texts: string[] = [];
    for (const email of ["connue@exemple.fr", "jamais-vue@exemple.fr"]) {
      const user = userEvent.setup();
      const { container, unmount } = renderSignIn();
      await askCode(user, email);
      texts.push(container.textContent!.replace(email, "<adresse>"));
      unmount();
    }
    expect(texts[0]).toBe(texts[1]);
    expect(texts[0]).not.toMatch(/inconnu|aucun compte|n’existe pas/i);
  });

  it("checks the address before sending anything", async () => {
    const user = userEvent.setup();
    renderSignIn();
    await user.type(
      await screen.findByLabelText("Adresse email"),
      "élodie@exemple.fr",
    );
    await user.click(screen.getByRole("button", { name: "Recevoir mon code" }));
    expect(screen.getByText(/sans accents/)).toBeTruthy();
    expect(api.to(/\/session\/code$/, "POST")).toHaveLength(0);
  });

  it("unavailable (no email delivery yet): an honest state, no code field, no bypass", async () => {
    api.on("POST", /\/session\/code$/, fail("client_hub_unavailable", 503));
    const user = userEvent.setup();
    renderSignIn();
    await user.type(
      await screen.findByLabelText("Adresse email"),
      "camille@exemple.fr",
    );
    await user.click(screen.getByRole("button", { name: "Recevoir mon code" }));

    expect(
      await screen.findByRole("heading", {
        name: "Accès temporairement indisponible",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Aucun code n’a été envoyé/)).toBeTruthy();
    expect(screen.queryByLabelText("Code à 8 chiffres")).toBeNull();
    expect(api.to(/\/session\/verify$/, "POST")).toHaveLength(0);
  });

  it("too many requests: says to wait, never asks again by itself", async () => {
    api.on("POST", /\/session\/code$/, fail("rate_limited", 429));
    const user = userEvent.setup();
    renderSignIn();
    await user.type(
      await screen.findByLabelText("Adresse email"),
      "camille@exemple.fr",
    );
    await user.click(screen.getByRole("button", { name: "Recevoir mon code" }));
    expect(await screen.findByText("Trop de demandes")).toBeTruthy();
    expect(api.to(/\/session\/code$/, "POST")).toHaveLength(1);
  });

  it("offline: says so, stays on the address", async () => {
    api.on("POST", /\/session\/code$/, "network");
    const user = userEvent.setup();
    renderSignIn();
    await user.type(
      await screen.findByLabelText("Adresse email"),
      "camille@exemple.fr",
    );
    await user.click(screen.getByRole("button", { name: "Recevoir mon code" }));
    expect(await screen.findByText("Connexion interrompue")).toBeTruthy();
    expect(screen.getByLabelText("Adresse email")).toBeTruthy();
  });
});

describe("the code", () => {
  it("a pasted code with a space is sent once, complete, with its challenge and address", async () => {
    const user = userEvent.setup();
    renderSignIn();
    const input = await askCode(user);
    await user.click(input);
    await user.paste("1234 5678");

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/espace"));
    const verify = api.to(/\/session\/verify$/, "POST");
    expect(verify).toHaveLength(1);
    expect(verify[0]!.body).toEqual({
      challengeId: CHALLENGE,
      email: "camille@exemple.fr",
      code: "12345678",
    });
    expect(verify[0]!.headers.get("content-type")).toBe("application/json");
  });

  it("is never kept: not in the page, not in any storage", async () => {
    const user = userEvent.setup();
    const { container } = renderSignIn();
    const input = await askCode(user);
    await user.type(input, "12345678");
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(container.innerHTML).not.toContain("12345678");
    expect(
      JSON.stringify({ ...window.localStorage, ...window.sessionStorage }),
    ).not.toContain("12345678");
    expect(document.cookie).toBe("");
  });

  it("a wrong code: one message, the field cleared and still focused, attempts counted", async () => {
    const user = userEvent.setup();
    renderSignIn();
    const input = await askCode(user);
    await user.type(input, "00000000");

    expect(await screen.findByText(/Ce code n’est pas valable/)).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(input);
    await user.type(input, "1");
    expect(screen.getByText(`${ATTEMPTS - 1} essais restants`)).toBeTruthy();
  });

  it(`after ${ATTEMPTS} wrong codes the code is exhausted: no more attempts, a new code is offered`, async () => {
    const user = userEvent.setup();
    renderSignIn();
    const input = (await askCode(user)) as HTMLInputElement;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      await user.type(input, "00000000");
      await screen.findByText(/n’est pas valable|Trop d’essais/);
    }
    expect(await screen.findByText(/Trop d’essais pour ce code/)).toBeTruthy();
    expect(input.disabled).toBe(true);
    expect(api.to(/\/session\/verify$/, "POST")).toHaveLength(ATTEMPTS);
  });

  it("an expired code cannot be sent; the screen says to ask for a new one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.on("POST", /\/session\/code$/, () =>
      ok(
        {
          challengeId: CHALLENGE,
          expiresAt: new Date(Date.now() + 5_000).toISOString(),
        },
        202,
      ),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSignIn();
    const input = (await askCode(user)) as HTMLInputElement;
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(await screen.findByText(/Ce code a expiré/)).toBeTruthy();
    expect(input.disabled).toBe(true);
    expect(api.to(/\/session\/verify$/, "POST")).toHaveLength(0);
  });

  it("a new code after the pause: the new challenge is used, the old one forgotten", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSignIn();
    await askCode(user);
    const resend = screen.getByRole("button", {
      name: /Renvoyer dans/,
    }) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);

    api.on("POST", /\/session\/code$/, () =>
      ok({ challengeId: SECOND, expiresAt: inTen() }, 202),
    );
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    await user.click(
      screen.getByRole("button", { name: "Recevoir un nouveau code" }),
    );
    expect(
      await screen.findByText(/nouveau code vient d’être envoyé/),
    ).toBeTruthy();

    await user.type(screen.getByLabelText("Code à 8 chiffres"), "12345678");
    await waitFor(() =>
      expect(api.to(/\/session\/verify$/, "POST")).toHaveLength(1),
    );
    expect(
      (api.to(/\/session\/verify$/, "POST")[0]!.body as { challengeId: string })
        .challengeId,
    ).toBe(SECOND);
  });

  it("no answer to the verification: says so, and asks who is signed in (the session may exist)", async () => {
    api.on("POST", /\/session\/verify$/, "network");
    const user = userEvent.setup();
    renderSignIn();
    const input = await askCode(user);
    const before = api.to(/\/me$/).length;
    await user.type(input, "12345678");
    expect(await screen.findByText("Vérification interrompue")).toBeTruthy();
    await waitFor(() => expect(api.to(/\/me$/).length).toBe(before + 1));
  });

  it("the code being typed survives a session check (back from the mail app, offline first check)", async () => {
    api.on("GET", /\/me$/, "network");
    const user = userEvent.setup();
    renderSignIn();
    const input = await askCode(user);
    await user.type(input, "1234");
    api.on("GET", /\/me$/, fail("client_hub_unauthenticated", 401));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(
      (screen.getByLabelText("Code à 8 chiffres") as HTMLInputElement).value,
    ).toBe("1234");
  });

  it("offline verification stays on the code with its message, even when the check fails too", async () => {
    api.on("POST", /\/session\/verify$/, "network");
    api.on("GET", /\/me$/, "network");
    const user = userEvent.setup();
    renderSignIn();
    const input = await askCode(user);
    await user.type(input, "12345678");
    expect(await screen.findByText("Vérification interrompue")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByText("Vérification interrompue")).toBeTruthy();
    expect(screen.getByLabelText("Code à 8 chiffres")).toBeTruthy();
  });

  it("no new code while one is being checked: its answer belongs to the current challenge", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const held = deferred<ReturnType<typeof ok>>();
    api.on("POST", /\/session\/verify$/, () => held.promise);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSignIn();
    const input = await askCode(user);
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    await user.type(input, "00000000");
    const resend = screen.getByRole("button", {
      name: "Recevoir un nouveau code",
    }) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    await act(async () => {
      held.resolve(fail("client_hub_code_invalid", 400));
    });
    expect(resend.disabled).toBe(false);
  });

  it("changing the address goes back with it, nothing sent", async () => {
    const user = userEvent.setup();
    renderSignIn();
    await askCode(user);
    await user.click(
      screen.getByRole("button", { name: /Modifier l’adresse/ }),
    );
    expect(
      (screen.getByLabelText("Adresse email") as HTMLInputElement).value,
    ).toBe("camille@exemple.fr");
    expect(api.to(/\/session\/verify$/, "POST")).toHaveLength(0);
  });
});

describe("the session", () => {
  it("already signed in: straight to the hub", async () => {
    signedIn = true;
    renderSignIn();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/espace"));
    expect(screen.queryByLabelText("Adresse email")).toBeNull();
  });

  it("a slow first check never shows the form to a signed-in customer", async () => {
    const held = deferred<ReturnType<typeof ok>>();
    api.on("GET", /\/me$/, () => held.promise);
    renderSignIn();
    expect(screen.queryByLabelText("Adresse email")).toBeNull();
    signedIn = true;
    held.resolve(ok(profile("camille@exemple.fr", [])));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/espace"));
  });

  it("the server cannot be reached: the form, with the problem and a way to retry", async () => {
    api.on("GET", /\/me$/, "network");
    renderSignIn();
    expect(await screen.findByText("Connexion interrompue")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect(api.to(/\/me$/).length).toBe(2));
  });
});

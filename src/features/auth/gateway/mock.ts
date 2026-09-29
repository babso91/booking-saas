/**
 * MOCK ADAPTER — temporary, for UI development only.
 *
 * Simulates the auth/onboarding backend in the browser (sessionStorage) with
 * realistic latency. It holds no security meaning and must be replaced by the
 * Supabase-backed adapter once the backend PR is merged (see ./index.ts).
 *
 * Built-in behaviours, besides the dev panel scenarios:
 * - sign-in with password "wrong-password"     → invalid_credentials
 * - sign-up with an email containing "+verify" → confirmation email screen
 * - slugs "studio-mila", "jade-beauty", "lash-studio"… are already taken
 * - completing with slug "pris-entre-temps"     → slug_taken (race)
 */
import type {
  AuthGateway,
  GatewayError,
  GatewayErrorCode,
  OnboardingGateway,
} from "./contract";
import { getMockScenario, scenarioError } from "./mock-scenario";
import { RESERVED_SLUGS, suggestSlugs } from "@/features/onboarding/slug";

const SESSION_KEY = "mock:session";
const TAKEN_SLUGS = new Set([
  "studio-mila",
  "jade-beauty",
  "jadebeauty",
  "lash-studio",
  "nail-studio",
  "beaute",
  "ongles",
  "cils",
]);

type MockSession = { email: string; onboardedSlug?: string };

let memorySession: MockSession | null = null;

function readSession(): MockSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as MockSession) : null;
  } catch {
    return memorySession;
  }
}

function writeSession(session: MockSession | null) {
  memorySession = session;
  try {
    if (session) {
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } else {
      window.sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // Memory fallback already updated.
  }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

const latency = () => 550 + Math.round(Math.random() * 350);
const fail = (
  code: GatewayErrorCode,
  fieldErrors?: GatewayError["fieldErrors"],
): { ok: false; error: GatewayError } => ({
  ok: false,
  error: fieldErrors ? { code, fieldErrors } : { code },
});

export const mockAuthGateway: AuthGateway = {
  async signUp({ email }) {
    await wait(latency());

    const forced = scenarioError(["network"]);
    if (forced) return fail(forced);

    if (
      getMockScenario() === "confirmation_required" ||
      email.includes("+verify")
    ) {
      return { ok: true, data: { status: "confirmation_required", email } };
    }

    writeSession({ email });
    return { ok: true, data: { status: "session" } };
  },

  async signIn({ email, password }) {
    await wait(latency());

    const forced = scenarioError([
      "network",
      "invalid_credentials",
      "email_not_confirmed",
    ]);
    if (forced) return fail(forced);
    if (password === "wrong-password") return fail("invalid_credentials");

    const previous = readSession();
    writeSession(
      previous?.email === email
        ? previous
        : { email, onboardedSlug: undefined },
    );
    return { ok: true, data: undefined };
  },

  async signOut() {
    await wait(250);
    writeSession(null);
    return { ok: true, data: undefined };
  },
};

export const mockOnboardingGateway: OnboardingGateway = {
  async getOnboardingStatus() {
    await wait(300);

    const forced = scenarioError(["network", "unauthorized"]);
    if (forced) return fail(forced);

    const session = readSession();
    if (!session) return fail("unauthorized");
    if (session.onboardedSlug || getMockScenario() === "already_onboarded") {
      return {
        ok: true,
        data: {
          status: "onboarded",
          slug: session.onboardedSlug ?? "studio-mila",
        },
      };
    }

    return {
      ok: true,
      data: { status: "needs_onboarding", email: session.email },
    };
  },

  async checkSlug(slug, options) {
    await wait(380 + Math.round(Math.random() * 240), options?.signal);

    const forced = scenarioError(["network"]);
    if (forced) return fail(forced);

    const availability = RESERVED_SLUGS.has(slug)
      ? "reserved"
      : TAKEN_SLUGS.has(slug)
        ? "taken"
        : "available";

    return {
      ok: true,
      data: {
        slug,
        availability,
        suggestions:
          availability === "available"
            ? []
            : suggestSlugs(slug).filter(
                (candidate) => !TAKEN_SLUGS.has(candidate),
              ),
      },
    };
  },

  async completeOnboarding(input) {
    await wait(900 + Math.round(Math.random() * 400));

    const forced = scenarioError([
      "network",
      "slug_taken",
      "already_onboarded",
      "unauthorized",
      "invalid_input",
    ]);
    if (forced === "invalid_input") {
      return fail("invalid_input", {
        businessName:
          "Ce nom n’a pas pu être enregistré. Modifie-le légèrement.",
      });
    }
    if (forced) return fail(forced);

    const session = readSession();
    if (!session) return fail("unauthorized");
    if (session.onboardedSlug) return fail("already_onboarded");
    if (TAKEN_SLUGS.has(input.slug) || input.slug === "pris-entre-temps") {
      return fail("slug_taken");
    }

    writeSession({ ...session, onboardedSlug: input.slug });
    return {
      ok: true,
      data: { slug: input.slug, businessName: input.businessName },
    };
  },
};

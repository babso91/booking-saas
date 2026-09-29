/**
 * TEMPORARY FRONTEND CONTRACT — auth & onboarding.
 *
 * The real contracts are being defined by the backend work (Supabase Auth,
 * onboarding RPC, sessions). The UI only depends on the interfaces below, so
 * wiring the real implementation means writing one adapter that satisfies
 * `AuthGateway` and `OnboardingGateway` and selecting it in `./index.ts`.
 *
 * Rules the UI relies on:
 * - functions never throw for expected failures: they resolve to a `Result`;
 * - `error.code` is one of `GatewayErrorCode`, never a raw Supabase/Postgres
 *   error. Adapters translate provider errors with `normalizeGatewayError`;
 * - `fieldErrors` keys use the `OnboardingInput` / credential field names.
 */

export type GatewayErrorCode =
  | "invalid_credentials"
  | "email_not_confirmed"
  | "email_taken"
  | "weak_password"
  | "rate_limited"
  | "slug_taken"
  | "already_onboarded"
  | "unauthorized"
  | "invalid_input"
  | "network"
  | "unknown";

export type GatewayError = {
  code: GatewayErrorCode;
  fieldErrors?: Partial<Record<string, string>>;
};

export type Result<T> =
  { ok: true; data: T } | { ok: false; error: GatewayError };

export type Credentials = {
  email: string;
  password: string;
};

export type SignUpOutcome =
  // A session exists right away: continue to onboarding.
  | { status: "session" }
  // Email confirmation is enabled: show the "check your inbox" screen.
  | { status: "confirmation_required"; email: string };

export type OnboardingStatus =
  | { status: "needs_onboarding"; email: string }
  | { status: "onboarded"; slug: string };

export type SlugAvailability = {
  slug: string;
  // Indicative only: the slug is reserved by `completeOnboarding`, never by
  // this check. The UI must not present "available" as a guarantee.
  availability: "available" | "taken" | "reserved";
  suggestions: string[];
};

// Mirrors the columns of `businesses` / `business_settings` it will populate.
export type OnboardingInput = {
  firstName: string;
  lastName: string;
  businessName: string;
  slug: string;
  timezone: string;
  minimumBookingNoticeMinutes: number;
  maximumBookingAdvanceDays: number;
  bufferMinutes: number;
  phone?: string;
  location?: string;
  description?: string;
  cancellationPolicy?: string;
};

export type OnboardingCompletion = {
  slug: string;
  businessName: string;
};

export interface AuthGateway {
  signUp(input: Credentials): Promise<Result<SignUpOutcome>>;
  signIn(input: Credentials): Promise<Result<void>>;
  signOut(): Promise<Result<void>>;
}

export interface OnboardingGateway {
  getOnboardingStatus(): Promise<Result<OnboardingStatus>>;
  checkSlug(
    slug: string,
    options?: { signal?: AbortSignal },
  ): Promise<Result<SlugAvailability>>;
  completeOnboarding(
    input: OnboardingInput,
  ): Promise<Result<OnboardingCompletion>>;
}

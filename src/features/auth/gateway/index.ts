/**
 * Single swap point between the UI and the backend.
 *
 * TODO(backend-merge): replace the mock with the Supabase-backed adapters
 * (browser client or Server Actions) once the auth/onboarding backend PR is
 * merged. Nothing else in the UI needs to change as long as the adapters
 * implement `AuthGateway` / `OnboardingGateway` from ./contract.
 */
import type { AuthGateway, OnboardingGateway } from "./contract";
import { mockAuthGateway, mockOnboardingGateway } from "./mock";

export const authGateway: AuthGateway = mockAuthGateway;
export const onboardingGateway: OnboardingGateway = mockOnboardingGateway;

// Whether the dev scenario panel should be offered.
export const isMockGateway = true;

export type * from "./contract";
export { describeGatewayError, normalizeGatewayError } from "./errors";

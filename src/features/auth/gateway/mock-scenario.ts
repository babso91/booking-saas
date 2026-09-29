import type { GatewayErrorCode } from "./contract";

/**
 * MOCK ONLY — lets a developer force the next gateway responses from the
 * dev panel, to review every error screen without a backend.
 */
export const mockScenarios = [
  "auto",
  "network",
  "invalid_credentials",
  "email_not_confirmed",
  "confirmation_required",
  "slug_taken",
  "already_onboarded",
  "unauthorized",
  "invalid_input",
] as const;

export type MockScenario = (typeof mockScenarios)[number];

const STORAGE_KEY = "mock:scenario";
let memoryScenario: MockScenario = "auto";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function getMockScenario(): MockScenario {
  const stored = storage()?.getItem(STORAGE_KEY);
  return mockScenarios.includes(stored as MockScenario)
    ? (stored as MockScenario)
    : memoryScenario;
}

export function setMockScenario(scenario: MockScenario) {
  memoryScenario = scenario;
  storage()?.setItem(STORAGE_KEY, scenario);
}

export function scenarioError(
  applicable: readonly GatewayErrorCode[],
): GatewayErrorCode | null {
  const scenario = getMockScenario();
  return (applicable as readonly string[]).includes(scenario)
    ? (scenario as GatewayErrorCode)
    : null;
}

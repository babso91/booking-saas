import { vi } from "vitest";

// Shared useRouter double for component tests: `vi.mock("next/navigation",
// () => nextNavigationMock)` then assert on `router.replace`.
export const router = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
};

export const nextNavigationMock = {
  useRouter: () => router,
};

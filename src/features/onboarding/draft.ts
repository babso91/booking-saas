import { defaultBookingSettings, DEFAULT_TIMEZONE } from "./settings";

export type OnboardingDraft = {
  firstName: string;
  lastName: string;
  businessName: string;
  slug: string;
  // Once edited by hand, the slug stops following the business name.
  slugEdited: boolean;
  timezone: string;
  minimumBookingNoticeMinutes: number;
  maximumBookingAdvanceDays: number;
  bufferMinutes: number;
  phone: string;
  location: string;
  description: string;
  cancellationPolicy: string;
};

export const emptyDraft: OnboardingDraft = {
  firstName: "",
  lastName: "",
  businessName: "",
  slug: "",
  slugEdited: false,
  timezone: DEFAULT_TIMEZONE,
  ...defaultBookingSettings,
  phone: "",
  location: "",
  description: "",
  cancellationPolicy: "",
};

// Tab-scoped persistence so a refresh or an expired session does not lose
// answers. Cleared once onboarding succeeds.
const KEY = "onboarding:draft";

export function loadDraft(): { draft: OnboardingDraft; step: number } | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      draft?: Partial<OnboardingDraft>;
      step?: number;
    };
    return {
      draft: { ...emptyDraft, ...parsed.draft },
      step: Math.min(3, Math.max(0, Number(parsed.step) || 0)),
    };
  } catch {
    return null;
  }
}

export function saveDraft(draft: OnboardingDraft, step: number) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ draft, step }));
  } catch {
    // Storage unavailable (private mode, quota): persistence is best effort.
  }
}

export function clearDraft() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Ignore.
  }
}

export function initials(value: string) {
  const letters = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "");
  return letters.join("") || "·";
}

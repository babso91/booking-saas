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
// answers. It holds form answers only (never credentials or tokens). Each
// account has its own slot, keyed by its stable Auth user id, so one account
// can neither read nor overwrite another's answers. Cleared on success and
// on sign-out.
const PREFIX = "onboarding:draft:";

const keyFor = (owner: string) => `${PREFIX}${owner}`;

export function loadDraft(
  owner: string,
): { draft: OnboardingDraft; step: number } | null {
  try {
    const raw = window.sessionStorage.getItem(keyFor(owner));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      owner?: string;
      draft?: Partial<OnboardingDraft>;
      step?: number;
    };
    // Defence in depth: a slot must describe its own account.
    if (parsed.owner !== owner) {
      clearDraft(owner);
      return null;
    }
    return {
      draft: { ...emptyDraft, ...parsed.draft },
      step: Math.min(3, Math.max(0, Number(parsed.step) || 0)),
    };
  } catch {
    return null;
  }
}

export function saveDraft(draft: OnboardingDraft, step: number, owner: string) {
  try {
    window.sessionStorage.setItem(
      keyFor(owner),
      JSON.stringify({ owner, draft, step }),
    );
  } catch {
    // Storage unavailable (private mode, quota): persistence is best effort.
  }
}

/** Removes one account's draft (after its onboarding succeeded). */
export function clearDraft(owner: string) {
  try {
    window.sessionStorage.removeItem(keyFor(owner));
  } catch {
    // Ignore.
  }
}

/** Removes every onboarding draft of this tab (sign-out). */
export function clearAllDrafts() {
  try {
    const storage = window.sessionStorage;
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(PREFIX)) storage.removeItem(key);
    }
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

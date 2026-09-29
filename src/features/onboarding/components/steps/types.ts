import type { Ref } from "react";

import type { OnboardingDraft } from "../../draft";

export type StepProps = {
  draft: OnboardingDraft;
  update: <K extends keyof OnboardingDraft>(
    key: K,
    value: OnboardingDraft[K],
  ) => void;
  errors: Partial<Record<keyof OnboardingDraft, string>>;
  shakeKey: number;
  headingRef: Ref<HTMLHeadingElement>;
  registerField: (
    name: keyof OnboardingDraft,
  ) => (element: HTMLElement | null) => void;
};

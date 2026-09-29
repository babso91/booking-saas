"use client";

import { useSyncExternalStore } from "react";

import { BrandMark } from "@/components/shared/brand-mark";

import { OnboardingSkeleton } from "./onboarding-skeleton";
import { OnboardingWizard } from "./onboarding-wizard";

const noop = () => () => {};

/**
 * Access is decided on the server (requirePendingOnboarding) before anything
 * renders. The wizard mounts on the client only, because it restores the
 * tab-scoped draft from sessionStorage.
 *
 * `owner` is the stable Auth user id. Keying the wizard by it discards the
 * whole in-memory state of account A (answers, slug checks, errors) before
 * account B renders, in the same commit: nothing of A can be shown to B or
 * saved into B's draft, even if the identity changes without a remount.
 */
export function OnboardingFlow({ owner }: { owner: string }) {
  const isClient = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );

  if (isClient) return <OnboardingWizard key={owner} owner={owner} />;

  return (
    <div className="flex min-h-dvh flex-1 flex-col px-5 pt-[max(env(safe-area-inset-top),0.75rem)] pb-10 sm:px-10">
      <header className="flex h-14 items-center">
        <BrandMark />
      </header>
      <main className="flex flex-1 flex-col justify-center py-10">
        <OnboardingSkeleton />
      </main>
    </div>
  );
}

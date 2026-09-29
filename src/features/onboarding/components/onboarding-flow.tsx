"use client";

import { useSyncExternalStore } from "react";

import { BrandMark } from "@/components/shared/brand-mark";

import { OnboardingSkeleton } from "./onboarding-skeleton";
import { OnboardingWizard } from "./onboarding-wizard";

const noop = () => () => {};

/**
 * Access is decided on the server (requirePendingOnboarding in the route
 * layout) before anything renders. The wizard itself mounts on the client
 * only, because it restores the tab-scoped draft from sessionStorage.
 */
export function OnboardingFlow({ owner }: { owner: string | null }) {
  const isClient = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );

  if (isClient) return <OnboardingWizard owner={owner} />;

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

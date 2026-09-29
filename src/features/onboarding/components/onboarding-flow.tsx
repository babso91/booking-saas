"use client";

import { useCallback, useEffect, useState } from "react";

import { BrandMark } from "@/components/shared/brand-mark";
import { onboardingGateway } from "@/features/auth/gateway";

import { Gate, OnboardingSkeleton } from "./gate";
import { OnboardingWizard } from "./onboarding-wizard";

type FlowState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "onboarded" }
  | { kind: "unauthorized" }
  | { kind: "network" };

/**
 * Resolves the onboarding status before showing the wizard.
 *
 * TODO(backend-merge): once sessions are server-side, the redirect for
 * signed-out or already onboarded users should happen on the server (page or
 * proxy) and this client gate becomes a fallback only.
 */
export function OnboardingFlow() {
  const [state, setState] = useState<FlowState>({ kind: "loading" });

  const load = useCallback(async () => {
    const result = await onboardingGateway.getOnboardingStatus();
    if (result.ok) {
      setState({
        kind: result.data.status === "onboarded" ? "onboarded" : "ready",
      });
    } else {
      setState({
        kind: result.error.code === "unauthorized" ? "unauthorized" : "network",
      });
    }
  }, []);

  useEffect(() => {
    let active = true;
    onboardingGateway.getOnboardingStatus().then((result) => {
      if (!active) return;
      if (result.ok) {
        setState({
          kind: result.data.status === "onboarded" ? "onboarded" : "ready",
        });
      } else {
        setState({
          kind:
            result.error.code === "unauthorized" ? "unauthorized" : "network",
        });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  if (state.kind === "ready") return <OnboardingWizard />;

  return (
    <div className="flex min-h-dvh flex-1 flex-col px-5 pt-[max(env(safe-area-inset-top),0.75rem)] pb-10 sm:px-10">
      <header className="flex h-14 items-center">
        <BrandMark />
      </header>
      <main className="flex flex-1 flex-col justify-center py-10">
        {state.kind === "loading" ? (
          <OnboardingSkeleton />
        ) : (
          <Gate
            kind={state.kind}
            onRetry={() => {
              setState({ kind: "loading" });
              void load();
            }}
          />
        )}
      </main>
    </div>
  );
}

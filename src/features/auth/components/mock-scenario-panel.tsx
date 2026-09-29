"use client";

import { useState, useSyncExternalStore } from "react";

import { isMockGateway } from "@/features/auth/gateway";
import {
  getMockScenario,
  mockScenarios,
  setMockScenario,
  type MockScenario,
} from "@/features/auth/gateway/mock-scenario";
import { cn } from "@/lib/cn";

const labels: Record<MockScenario, string> = {
  auto: "Normal",
  network: "Erreur réseau",
  invalid_credentials: "Identifiants incorrects",
  email_not_confirmed: "Email non confirmé",
  confirmation_required: "Inscription → email à confirmer",
  slug_taken: "Lien pris (à la validation)",
  already_onboarded: "Déjà onboardée",
  unauthorized: "Session expirée",
  invalid_input: "Données refusées",
};

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * DEV ONLY — forces mock gateway responses to review error states. Rendered
 * only in development while the mock adapter is active.
 */
export function MockScenarioPanel() {
  if (process.env.NODE_ENV === "production" || !isMockGateway) return null;
  return <Panel />;
}

function Panel() {
  const [open, setOpen] = useState(false);
  const scenario = useSyncExternalStore(
    subscribe,
    getMockScenario,
    () => "auto" as MockScenario,
  );

  const choose = (next: MockScenario) => {
    setMockScenario(next);
    listeners.forEach((listener) => listener());
  };

  return (
    <div className="fixed top-3.5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2 text-[12px] lg:top-auto lg:right-6 lg:bottom-6 lg:left-auto lg:translate-x-0 lg:flex-col-reverse lg:items-end">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        title={`Backend simulé : ${labels[scenario]}`}
        className={cn(
          "flex h-8 cursor-pointer items-center gap-2 rounded-full border px-3 font-medium shadow-sm backdrop-blur transition-colors",
          scenario === "auto"
            ? "border-line bg-paper-raised/90 text-ink-soft"
            : "border-warning/30 bg-warning-soft text-warning",
        )}
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            scenario === "auto" ? "bg-success" : "bg-warning",
          )}
        />
        Mock
        <span className="hidden lg:inline">· {labels[scenario]}</span>
      </button>
      {open ? (
        <div className="w-64 animate-message rounded-2xl border border-line bg-paper-raised p-2 shadow-xl">
          <p className="px-2 pt-1 pb-2 text-ink-muted">
            Prochaines réponses du backend simulé
          </p>
          {mockScenarios.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => choose(item)}
              className={cn(
                "flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 text-left hover:bg-sand",
                item === scenario ? "font-semibold text-ink" : "text-ink-soft",
              )}
            >
              {labels[item]}
              {item === scenario ? <span aria-hidden="true">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

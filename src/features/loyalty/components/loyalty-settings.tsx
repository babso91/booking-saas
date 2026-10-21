"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { callAction, type UiError } from "@/features/auth/client/call-action";
import { getBookingSettingsAction } from "@/features/availability/actions/schedule";
import { CrmError } from "@/features/crm/components/crm-error";
import {
  getLoyaltyProgramAction,
  listRewardsAction,
} from "@/features/loyalty/actions/loyalty";
import type { ServiceView } from "@/features/services/client/service-form";
import { listServicesAction } from "@/features/services/actions/services";

import type { LoyaltyProgramDto, RewardDto } from "../types";
import { ProgramSection } from "./program-section";
import { RewardsSection } from "./rewards-section";
import { ServiceRules } from "./service-rules";

type Load =
  | { status: "loading" }
  | { status: "error"; error: UiError }
  | {
      status: "ready";
      program: LoyaltyProgramDto;
      rewards: RewardDto[];
      services: ServiceView[];
      currency: string;
    };

/**
 * The loyalty section of the professional area: the program (activation,
 * calculation), its per-service rules and the rewards. Everything comes
 * from the loyalty Server Actions (docs/LOYALTY_CONTRACT.md); a read
 * applies only if it is the latest. The page mounts one instance per
 * identity (signed-in user and business).
 */
export function LoyaltySettings() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [run, setRun] = useState(0);
  const reads = useRef(0);

  useEffect(() => {
    const read = (reads.current += 1);
    void Promise.all([
      callAction(() => getLoyaltyProgramAction()),
      callAction(() => listRewardsAction()),
      callAction(() => listServicesAction()),
      callAction(() => getBookingSettingsAction()),
    ]).then(([program, rewards, services, settings]) => {
      if (read !== reads.current) return;
      if (!program.ok)
        return setLoad({ status: "error", error: program.error });
      if (!rewards.ok)
        return setLoad({ status: "error", error: rewards.error });
      if (!services.ok)
        return setLoad({ status: "error", error: services.error });
      if (!settings.ok)
        return setLoad({ status: "error", error: settings.error });
      setLoad({
        status: "ready",
        program: program.data,
        rewards: rewards.data,
        services: services.data,
        currency: settings.data.currency,
      });
    });
    return () => {
      reads.current += 1;
    };
  }, [run]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 pt-5 pb-16 sm:px-6 lg:px-8 lg:pt-8">
        <header className="flex flex-col gap-1.5">
          <h1 className="font-display text-[34px] leading-none text-ink sm:text-[42px]">
            Fidélité
          </h1>
          <p className="max-w-2xl text-[14.5px] text-ink-soft">
            Récompense tes clientes fidèles : elles gagnent des points à chaque
            rendez-vous terminé et les échangent contre des récompenses. Les
            soldes et les attributions se gèrent depuis{" "}
            <Link
              href="/app/clients"
              className="font-medium text-ink underline decoration-line-strong underline-offset-4"
            >
              chaque fiche cliente
            </Link>
            .
          </p>
        </header>

        {load.status === "loading" ? (
          <div className="flex flex-col gap-4" aria-busy="true">
            <span className="sr-only" role="status">
              Chargement de la fidélité…
            </span>
            <span className="h-40 animate-pulse rounded-3xl bg-sand/70" />
            <span className="h-64 animate-pulse rounded-3xl bg-sand/50" />
          </div>
        ) : load.status === "error" ? (
          <CrmError
            error={load.error}
            onRetry={() => {
              setLoad({ status: "loading" });
              setRun((value) => value + 1);
            }}
          >
            {load.error.code === "unauthenticated"
              ? undefined
              : "La fidélité n’a pas pu être chargée."}
          </CrmError>
        ) : (
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-5">
              <ProgramSection
                key={run}
                program={load.program}
                onProgram={(program) =>
                  setLoad((value) =>
                    value.status === "ready" ? { ...value, program } : value,
                  )
                }
              />
              <ServiceRules
                program={load.program}
                services={load.services}
                currency={load.currency}
                onRules={(serviceRules) =>
                  setLoad((value) =>
                    value.status === "ready"
                      ? {
                          ...value,
                          program: { ...value.program, serviceRules },
                        }
                      : value,
                  )
                }
              />
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              <RewardsSection
                rewards={load.rewards}
                services={load.services}
                currency={load.currency}
                programActive={load.program.active}
                onRewards={(update) =>
                  setLoad((value) =>
                    value.status === "ready"
                      ? { ...value, rewards: update(value.rewards) }
                      : value,
                  )
                }
              />
              <Rules />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Rules() {
  return (
    <section
      aria-label="Bon à savoir"
      className="flex flex-col gap-2 rounded-3xl border border-line bg-sand/40 px-5 py-5 text-[14px] text-ink-soft sm:px-6"
    >
      <h2 className="font-display text-[20px] leading-tight text-ink">
        Bon à savoir
      </h2>
      <ul className="flex list-disc flex-col gap-1.5 pl-5">
        <li>
          Les points arrivent quand tu marques un rendez-vous « terminé » dans
          l’agenda. Une réservation seule ne rapporte rien.
        </li>
        <li>
          Si tu rouvres un rendez-vous terminé, ses points sont retirés
          automatiquement.
        </li>
        <li>Changer les règles ne modifie pas les points déjà gagnés.</li>
        <li>
          Attribuer une récompense débite les points ; tu l’appliques toi-même
          lors de la visite, rien n’est déduit automatiquement du prix.
        </li>
        <li>
          Les points n’expirent pas. Aucun email n’est envoyé à tes clientes
          pour la fidélité.
        </li>
      </ul>
    </section>
  );
}

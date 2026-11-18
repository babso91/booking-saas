"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Notice } from "@/components/ui/notice";
import { callAction } from "@/features/auth/client/call-action";
import { listServicesAction } from "@/features/services/actions/services";

import { CampaignPlanner, CampaignStatus } from "./campaign-planner";
import { realCampaignActions } from "./real-actions";

/**
 * Relances (docs/GROWTH_CAMPAIGNS_CONTRACT.md): plan a rebooking or
 * reactivation campaign, then follow it. The campaign's id stays in the
 * address (`?campagne=`), so leaving and coming back finds it again (there
 * is no list of campaigns yet). While the transport is simulated, nothing
 * really leaves, and the screens say so.
 */
export function CampaignsScreen({ campaignId }: { campaignId: string | null }) {
  const router = useRouter();
  const [services, setServices] = useState<
    { id: string; name: string }[] | null
  >(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (campaignId) return;
    let alive = true;
    void callAction(() => listServicesAction()).then((result) => {
      if (!alive) return;
      if (!result.ok) return setFailed(true);
      setServices(
        result.data
          .filter((service) => service.active)
          .map((service) => ({ id: service.id, name: service.name })),
      );
    });
    return () => {
      alive = false;
    };
  }, [campaignId]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-10">
        <Link
          href="/app/loyalty"
          className="w-fit text-[14px] font-medium text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink"
        >
          ← Fidélité
        </Link>
        <header className="flex flex-col gap-1.5">
          <h1 className="font-display text-[34px] leading-none text-ink sm:text-[40px]">
            Relances
          </h1>
          <p className="max-w-prose text-[14.5px] text-ink-soft">
            Propose un nouveau rendez-vous aux clientes qui ne sont pas
            revenues. Seules celles qui ont accepté de recevoir tes messages
            sont contactées.
          </p>
        </header>

        {campaignId ? (
          <>
            <CampaignStatus
              campaignId={campaignId}
              actions={realCampaignActions}
            />
            <button
              type="button"
              onClick={() => router.replace("/app/loyalty/relances")}
              className="w-fit cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
            >
              Préparer une autre relance
            </button>
          </>
        ) : failed ? (
          <Notice tone="error" title="Tes prestations n’ont pas pu être lues">
            Rien n’a été préparé. Recharge la page pour réessayer.
          </Notice>
        ) : services === null ? (
          <span className="h-40 animate-pulse rounded-xl bg-sand/60" />
        ) : (
          <CampaignPlanner
            services={services}
            actions={realCampaignActions}
            onScheduled={(campaign) =>
              router.replace(
                `/app/loyalty/relances?campagne=${campaign.campaignId}`,
              )
            }
          />
        )}
      </div>
    </div>
  );
}

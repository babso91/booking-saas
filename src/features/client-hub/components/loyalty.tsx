"use client";

import type { ReactNode } from "react";

import { GiftIcon, InfoIcon, SparkIcon } from "@/components/ui/icons";
import type {
  ClientHubBusinessDto,
  ClientHubIssuedRewardDto,
  ClientHubLedgerEntryDto,
  ClientHubLoyaltyDto,
  ClientHubRewardDto,
} from "@/features/client-hub/types";
import { cn } from "@/lib/cn";

import { fetchLedger, fetchLoyalty } from "../client/api";
import {
  issuedStatus,
  ledgerTitle,
  points,
  rewardValue,
  shortDate,
  signedPoints,
} from "../client/format";
import { useHubPages } from "../client/pages";
import { useHubRead } from "../client/session";
import {
  EmptyState,
  HubErrorNotice,
  Loading,
  MoreButton,
  Pill,
  SectionHeading,
  Skeleton,
} from "./hub-parts";
import { HubPage } from "./hub-shell";
import { BalanceCard, progress } from "./loyalty-visuals";

const PAGE = 20;

export function HubLoyalty({ businessId }: { businessId: string }) {
  return (
    <HubPage section="loyalty" businessId={businessId}>
      {({ business, switcher }) => (
        <Loyalty business={business!} switcher={switcher} />
      )}
    </HubPage>
  );
}

function Loyalty({
  business,
  switcher,
}: {
  business: ClientHubBusinessDto;
  switcher: ReactNode;
}) {
  const id = business.businessId;
  const read = useHubRead(`loyalty:${id}`, (signal) =>
    fetchLoyalty(id, signal),
  );

  return (
    <>
      <header className="flex animate-rise flex-col gap-2">
        <p className="text-[12.5px] font-semibold tracking-[0.16em] text-accent uppercase">
          {business.name}
        </p>
        <h1 className="font-display text-[44px] leading-none tracking-[-0.02em] text-ink sm:text-[52px]">
          Ma fidélité
        </h1>
      </header>
      {switcher}

      {read.status === "loading" ? (
        <Loading label="Chargement de votre fidélité…">
          <Skeleton className="h-[260px] w-full rounded-[30px] bg-ink/10" />
          <Skeleton className="h-24 w-full rounded-[24px]" />
          <Skeleton className="h-24 w-full rounded-[24px]" />
        </Loading>
      ) : read.status === "error" ? (
        <HubErrorNotice error={read.error} onRetry={read.reload}>
          Votre fidélité n’a pas pu être chargée.
        </HubErrorNotice>
      ) : (
        <Content business={business} loyalty={read.data} />
      )}
    </>
  );
}

function Content({
  business,
  loyalty,
}: {
  business: ClientHubBusinessDto;
  loyalty: ClientHubLoyaltyDto;
}) {
  const rewards = [...loyalty.rewards].sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      a.pointsRequired - b.pointsRequired,
  );

  return (
    // Phones: the card, then what she can get, the explanation last.
    // Large screens: the card and the explanation alongside the lists.
    <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:grid-rows-[auto_1fr] lg:items-start">
      <div className="animate-rise [animation-delay:60ms] lg:col-start-1 lg:row-start-1">
        <BalanceCard businessName={business.name} loyalty={loyalty} />
      </div>
      <div className="flex flex-col gap-10 lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <section
          aria-labelledby="rewards-title"
          className="flex flex-col gap-4"
        >
          <SectionHeading id="rewards-title" title="Récompenses" />
          {rewards.length === 0 ? (
            <EmptyState
              icon={<GiftIcon size={20} />}
              title="Aucune récompense proposée"
            >
              {business.name} ne propose pas de récompense pour le moment.
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-3">
              {rewards.map((reward) => (
                <li key={reward.id}>
                  <RewardRow
                    reward={reward}
                    balance={loyalty.balance}
                    business={business}
                    paused={!loyalty.programActive}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {loyalty.issuedRewards.length > 0 ? (
          <section
            aria-labelledby="issued-title"
            className="flex flex-col gap-4"
          >
            <SectionHeading id="issued-title" title="Récompenses attribuées" />
            <ul className="flex flex-col gap-2.5">
              {loyalty.issuedRewards.map((issued) => (
                <li key={issued.id}>
                  <IssuedRow issued={issued} business={business} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <History business={business} />
      </div>

      <div className="lg:col-start-1 lg:row-start-2">
        <HowItWorks business={business} />
      </div>
    </div>
  );
}

function HowItWorks({ business }: { business: ClientHubBusinessDto }) {
  return (
    <aside className="flex flex-col gap-3 rounded-[26px] border border-line bg-paper-raised px-5 py-5">
      <p className="flex items-center gap-2 text-[15px] font-semibold text-ink">
        <InfoIcon size={18} /> Comment ça marche
      </p>
      <ul className="flex flex-col gap-2 text-[14px] leading-relaxed text-ink-soft">
        <li>
          Vos points sont crédités par {business.name}, en général après un
          rendez-vous terminé.
        </li>
        <li>
          Une récompense disponible se demande sur place : c’est votre
          professionnelle qui l’attribue et l’utilise lors d’un rendez-vous.
        </li>
        <li>
          Aucune réduction ne s’applique automatiquement à une réservation en
          ligne.
        </li>
      </ul>
    </aside>
  );
}

function RewardRow({
  reward,
  balance,
  business,
  paused,
}: {
  reward: ClientHubRewardDto;
  balance: number;
  business: ClientHubBusinessDto;
  paused: boolean;
}) {
  const share = progress(balance, reward);
  return (
    <article
      aria-label={reward.name}
      className={cn(
        "flex flex-col gap-3.5 rounded-[24px] border px-4 py-4 sm:px-5",
        reward.eligible
          ? "border-accent/25 bg-[linear-gradient(135deg,#fffcf8,var(--accent-soft))]"
          : "border-line bg-paper-raised",
      )}
    >
      <div className="flex items-start gap-3.5">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-2xl",
            reward.eligible
              ? "bg-accent text-paper-raised"
              : "bg-sand text-ink-soft",
          )}
        >
          {reward.eligible ? <SparkIcon size={19} /> : <GiftIcon size={19} />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h3 className="text-[16px] leading-snug font-semibold wrap-anywhere text-ink">
              {reward.name}
            </h3>
            <span className="text-[13.5px] font-semibold text-ink-soft tabular-nums">
              {points(reward.pointsRequired)}
            </span>
          </div>
          <p className="text-[14px] text-ink-soft">{rewardValue(reward)}</p>
          {reward.description ? (
            <p className="text-[13.5px] leading-relaxed wrap-anywhere whitespace-pre-line text-ink-muted">
              {reward.description}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <div
          role="progressbar"
          aria-label={`Progression vers ${reward.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
          className="h-1.5 overflow-hidden rounded-full bg-sand"
        >
          <span
            className={cn(
              "block h-full origin-left animate-[grow_900ms_var(--ease-out-soft)_both] rounded-full",
              reward.eligible ? "bg-accent" : "bg-ink/70",
            )}
            style={{ width: `${Math.max(share * 100, 2)}%` }}
          />
        </div>
        {reward.eligible ? (
          <p className="flex flex-wrap items-center gap-2 text-[13.5px] text-accent-strong">
            <Pill tone="accent">Disponible</Pill>
            {paused
              ? "Le programme est en pause : renseignez-vous auprès de votre établissement."
              : `À demander à ${business.name} lors d’un rendez-vous.`}
          </p>
        ) : (
          <p className="text-[13.5px] text-ink-muted">
            Encore{" "}
            <strong className="font-semibold text-ink-soft">
              {points(reward.missingPoints)}
            </strong>{" "}
            pour l’obtenir.
          </p>
        )}
      </div>
    </article>
  );
}

function IssuedRow({
  issued,
  business,
}: {
  issued: ClientHubIssuedRewardDto;
  business: ClientHubBusinessDto;
}) {
  const status = issuedStatus[issued.status];
  const zone = business.timezone;
  const detail =
    issued.status === "fulfilled" && issued.fulfilledAt
      ? `Utilisée le ${shortDate(issued.fulfilledAt, zone)}`
      : issued.status === "cancelled" && issued.cancelledAt
        ? `Annulée le ${shortDate(issued.cancelledAt, zone)}`
        : `Attribuée le ${shortDate(issued.issuedAt, zone)} · à utiliser avec ${business.name}`;
  return (
    <div className="flex items-center gap-3.5 rounded-[22px] border border-line bg-paper-raised px-4 py-3.5">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-xl",
          issued.status === "issued"
            ? "bg-accent-soft text-accent-strong"
            : "bg-sand text-ink-muted",
        )}
      >
        <GiftIcon size={18} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p
          className={cn(
            "text-[15px] font-semibold wrap-anywhere",
            issued.status === "cancelled" ? "text-ink-soft" : "text-ink",
          )}
        >
          {issued.name}
        </p>
        <p className="text-[13px] text-ink-muted">
          {rewardValue(issued)} · {points(issued.pointsSpent)}
        </p>
        <p className="text-[13px] text-ink-muted">{detail}</p>
      </div>
      <Pill tone={status.tone}>{status.label}</Pill>
    </div>
  );
}

function History({ business }: { business: ClientHubBusinessDto }) {
  const id = business.businessId;
  const { list, loadMore, reload } = useHubPages<ClientHubLedgerEntryDto>(
    `ledger:${id}`,
    (cursor, signal) => fetchLedger(id, { cursor, limit: PAGE }, signal),
  );

  return (
    <section aria-labelledby="history-title" className="flex flex-col gap-4">
      <SectionHeading id="history-title" title="Historique des points" />
      {list.status === "loading" ? (
        <Loading label="Chargement de l’historique…">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-16 w-full rounded-[20px]" />
          ))}
        </Loading>
      ) : list.status === "error" ? (
        <HubErrorNotice error={list.error} onRetry={reload}>
          L’historique n’a pas pu être chargé.
        </HubErrorNotice>
      ) : list.items.length === 0 ? (
        <EmptyState
          icon={<SparkIcon size={20} />}
          title="Aucun mouvement pour l’instant"
        >
          Vos points gagnés et utilisés chez {business.name} apparaîtront ici.
        </EmptyState>
      ) : (
        <>
          <ol className="flex flex-col divide-y divide-line overflow-hidden rounded-[24px] border border-line bg-paper-raised">
            {list.items.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-3 px-4 py-3.5 sm:px-5"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
                    entry.pointsDelta >= 0
                      ? "bg-success-soft text-success"
                      : "bg-sand text-ink-soft",
                  )}
                >
                  {entry.pointsDelta >= 0 ? "+" : "−"}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="text-[14.5px] font-medium wrap-anywhere text-ink">
                    {ledgerTitle(entry)}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-muted">
                    <span>{shortDate(entry.createdAt, business.timezone)}</span>
                    <span aria-hidden="true">·</span>
                    <span>Solde {points(entry.balanceAfter)}</span>
                    {entry.reversed ? (
                      <Pill tone="muted">Annulé ensuite</Pill>
                    ) : null}
                  </p>
                </div>
                <span
                  className={cn(
                    "shrink-0 text-[15px] font-semibold tabular-nums",
                    entry.pointsDelta >= 0 ? "text-success" : "text-ink-soft",
                    entry.reversed && "line-through decoration-line-strong",
                  )}
                >
                  <span className="sr-only">
                    {entry.pointsDelta >= 0 ? "Gain de " : "Retrait de "}
                    {points(Math.abs(entry.pointsDelta))}
                  </span>
                  <span aria-hidden="true">
                    {signedPoints(entry.pointsDelta)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          {list.nextCursor ? (
            <MoreButton
              state={list.more}
              onMore={loadMore}
              label="Afficher les plus anciens"
            />
          ) : null}
        </>
      )}
    </section>
  );
}

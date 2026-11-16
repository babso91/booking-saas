"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import {
  ArrowRightIcon,
  CalendarIcon,
  ChevronRightIcon,
} from "@/components/ui/icons";
import type {
  ClientHubAppointmentDto,
  ClientHubBusinessDto,
} from "@/features/client-hub/types";
import { cn } from "@/lib/cn";

import { fetchAppointments, type AppointmentScope } from "../client/api";
import {
  appointmentStatus,
  duration,
  monthHeading,
  relativeDay,
  timeOf,
} from "../client/format";
import { useHubPages } from "../client/pages";
import {
  DateTile,
  EmptyState,
  HubErrorNotice,
  Loading,
  MoreButton,
  Pill,
  Skeleton,
} from "./hub-parts";
import { HubPage, bookingHref, hubHref } from "./hub-shell";

const PAGE = 20;

export function HubAppointments({ businessId }: { businessId: string }) {
  return (
    <HubPage section="appointments" businessId={businessId}>
      {({ business, switcher }) => (
        <Appointments business={business!} switcher={switcher} />
      )}
    </HubPage>
  );
}

function Appointments({
  business,
  switcher,
}: {
  business: ClientHubBusinessDto;
  switcher: ReactNode;
}) {
  const [scope, setScope] = useState<AppointmentScope>("upcoming");

  return (
    <>
      <header className="flex animate-rise flex-col gap-2">
        <p className="text-[12.5px] font-semibold tracking-[0.16em] text-accent uppercase">
          {business.name}
        </p>
        <h1 className="font-display text-[44px] leading-none tracking-[-0.02em] text-ink sm:text-[52px]">
          Mes rendez-vous
        </h1>
      </header>
      {switcher}

      <div
        role="group"
        aria-label="Période"
        className="grid w-full max-w-sm grid-cols-2 rounded-full border border-line bg-paper-raised p-1"
      >
        {(
          [
            ["upcoming", "À venir"],
            ["past", "Passés"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={scope === value}
            onClick={() => setScope(value)}
            className={cn(
              "h-10 cursor-pointer rounded-full text-[14.5px] font-medium transition-[background-color,color] duration-200",
              scope === value
                ? "bg-ink text-paper-raised shadow-[0_8px_18px_-10px_rgba(35,28,24,0.6)]"
                : "text-ink-soft hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* One list per period: nothing of one is shown in the other. */}
      <AppointmentList key={scope} business={business} scope={scope} />

      <p className="text-[12.5px] text-ink-muted">
        Heures de {business.name} ({business.timezone}).
      </p>
    </>
  );
}

function AppointmentList({
  business,
  scope,
}: {
  business: ClientHubBusinessDto;
  scope: AppointmentScope;
}) {
  const id = business.businessId;
  const { list, loadMore, reload } = useHubPages<ClientHubAppointmentDto>(
    `${id}:${scope}`,
    (cursor, signal) =>
      fetchAppointments(id, { scope, cursor, limit: PAGE }, signal),
  );

  if (list.status === "loading") {
    return (
      <Loading label="Chargement des rendez-vous…">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-[92px] w-full rounded-[24px]" />
        ))}
      </Loading>
    );
  }
  if (list.status === "error") {
    return (
      <HubErrorNotice error={list.error} onRetry={reload}>
        Vos rendez-vous n’ont pas pu être chargés.
      </HubErrorNotice>
    );
  }
  if (list.items.length === 0) {
    return scope === "upcoming" ? (
      <EmptyState
        icon={<CalendarIcon size={20} />}
        title="Aucun rendez-vous à venir"
        action={
          <Link
            href={bookingHref(business.slug)}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[14.5px] font-medium text-paper-raised hover:bg-[#382d27]"
          >
            Prendre rendez-vous <ArrowRightIcon size={16} />
          </Link>
        }
      >
        Vos prochaines réservations chez {business.name} apparaîtront ici.
      </EmptyState>
    ) : (
      <EmptyState
        icon={<CalendarIcon size={20} />}
        title="Pas encore d’historique"
      >
        Vos rendez-vous passés chez {business.name} apparaîtront ici.
      </EmptyState>
    );
  }

  // Grouped by month, in the order the backend gives (closest first for
  // upcoming, most recent first for past).
  const groups: { month: string; items: ClientHubAppointmentDto[] }[] = [];
  for (const item of list.items) {
    const month = monthHeading(item.startsAt, business.timezone);
    const last = groups.at(-1);
    if (last?.month === month) last.items.push(item);
    else groups.push({ month, items: [item] });
  }

  return (
    <div className="flex flex-col gap-7">
      {groups.map((group) => (
        <section
          key={group.month}
          aria-label={group.month}
          className="flex flex-col gap-3"
        >
          <h2 className="px-1 text-[13px] font-semibold tracking-[0.14em] text-ink-muted uppercase first-letter:uppercase">
            {group.month}
          </h2>
          <ul className="flex flex-col gap-2.5">
            {group.items.map((appointment) => (
              <li key={appointment.id}>
                <AppointmentRow business={business} appointment={appointment} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {list.nextCursor ? (
        <MoreButton
          state={list.more}
          onMore={loadMore}
          label={
            scope === "upcoming"
              ? "Afficher les suivants"
              : "Afficher les plus anciens"
          }
        />
      ) : null}
    </div>
  );
}

function AppointmentRow({
  business,
  appointment,
}: {
  business: ClientHubBusinessDto;
  appointment: ClientHubAppointmentDto;
}) {
  const zone = business.timezone;
  const status = appointmentStatus[appointment.status];
  const inactive =
    appointment.status === "cancelled" || appointment.status === "no_show";
  const when =
    appointment.status === "confirmed"
      ? relativeDay(appointment.startsAt, zone)
      : null;

  return (
    <Link
      href={hubHref.appointment(business.businessId, appointment.id)}
      className="group flex items-center gap-4 rounded-[24px] border border-line bg-paper-raised px-3.5 py-3.5 transition-[border-color,box-shadow,transform] duration-200 ease-soft hover:-translate-y-px hover:border-line-strong hover:shadow-[0_16px_34px_-26px_rgba(35,28,24,0.5)] sm:px-4"
    >
      <DateTile iso={appointment.startsAt} timeZone={zone} muted={inactive} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={cn(
            "text-[16px] leading-snug font-semibold wrap-anywhere",
            inactive
              ? "text-ink-soft line-through decoration-line-strong"
              : "text-ink",
          )}
        >
          {appointment.serviceName}
        </span>
        <span className="text-[13.5px] text-ink-soft tabular-nums">
          {timeOf(appointment.startsAt, zone)} ·{" "}
          {duration(appointment.durationMinutes)}
        </span>
        <span className="flex flex-wrap gap-1.5 pt-0.5">
          {when ? <Pill tone="accent">{when}</Pill> : null}
          <Pill tone={status.tone}>{status.label}</Pill>
        </span>
      </span>
      <ChevronRightIcon
        size={18}
        className="shrink-0 text-ink-muted transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-ink"
      />
    </Link>
  );
}

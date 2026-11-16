"use client";

import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import {
  ArrowRightIcon,
  CalendarIcon,
  MailIcon,
  PinIcon,
} from "@/components/ui/icons";
import type {
  ClientHubAppointmentDto,
  ClientHubBusinessDto,
  ClientHubProfileDto,
} from "@/features/client-hub/types";
import { cn } from "@/lib/cn";

import { fetchAppointments, fetchLoyalty } from "../client/api";
import {
  appointmentStatus,
  duration,
  initial,
  longDay,
  relativeDay,
  timeOf,
} from "../client/format";
import { useHubRead } from "../client/session";
import {
  DateTile,
  EmptyState,
  HubErrorNotice,
  Pill,
  Skeleton,
} from "./hub-parts";
import { HubPage, bookingHref, hubHref } from "./hub-shell";
import { BalanceCard } from "./loyalty-visuals";

export function HubHome() {
  return (
    <HubPage section="home">
      {({ profile }) => <Home profile={profile} />}
    </HubPage>
  );
}

/** One first name for every business, or none (they may differ). */
function firstNameOf(profile: ClientHubProfileDto) {
  const names = new Set(
    profile.businesses.map((business) => business.customer.firstName.trim()),
  );
  return names.size === 1 ? [...names][0] || null : null;
}

function Home({ profile }: { profile: ClientHubProfileDto }) {
  const name = firstNameOf(profile);
  const zone = profile.businesses[0]?.timezone ?? "Europe/Paris";

  return (
    <>
      <header className="flex animate-rise flex-col gap-2 pt-2">
        <p className="text-[12.5px] font-semibold tracking-[0.16em] text-accent uppercase first-letter:uppercase">
          {longDay(new Date().toISOString(), zone)}
        </p>
        <h1 className="font-display text-[44px] leading-[0.98] tracking-[-0.02em] text-balance text-ink sm:text-[56px]">
          {name ? (
            <>
              Bonjour <em className="text-accent">{name}</em>
            </>
          ) : (
            "Bonjour"
          )}
        </h1>
        <p className="max-w-xl text-[15.5px] leading-relaxed text-ink-soft">
          {profile.businesses.length === 0
            ? "Bienvenue dans votre espace."
            : profile.businesses.length === 1
              ? "Retrouvez ici vos rendez-vous et vos avantages fidélité."
              : `Vos ${profile.businesses.length} établissements, chacun avec ses rendez-vous et sa propre carte fidélité.`}
        </p>
      </header>

      {profile.businesses.length === 0 ? (
        <EmptyState icon={<MailIcon size={20} />} title="Votre espace est prêt">
          Dès que votre établissement vous ouvre l’accès pour l’adresse{" "}
          <strong className="font-semibold wrap-anywhere text-ink">
            {profile.email}
          </strong>
          , vos rendez-vous et vos points apparaissent ici. Si vous pensez qu’il
          devrait déjà l’avoir fait, demandez-le-lui lors de votre prochaine
          visite.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-6">
          {profile.businesses.map((business, index) => (
            <li
              key={business.businessId}
              className="animate-rise"
              style={{ animationDelay: `${80 + index * 90}ms` }}
            >
              <BusinessCard business={business} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function BusinessCard({ business }: { business: ClientHubBusinessDto }) {
  const id = business.businessId;
  const upcoming = useHubRead(`upcoming:${id}`, (signal) =>
    fetchAppointments(id, { scope: "upcoming", limit: 1 }, signal),
  );
  const loyalty = useHubRead(`loyalty:${id}`, (signal) =>
    fetchLoyalty(id, signal),
  );
  const headingId = `business-${id}`;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-5 rounded-[32px] border border-line bg-paper-raised/90 p-4 shadow-[0_24px_60px_-40px_rgba(35,28,24,0.4)] sm:p-6"
    >
      <div className="flex items-center gap-3.5 px-1">
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-sand font-display text-[24px] text-ink"
        >
          {initial(business.name)}
        </span>
        <div className="flex min-w-0 flex-col">
          <h2
            id={headingId}
            className="font-display text-[28px] leading-tight tracking-[-0.01em] wrap-anywhere text-ink"
          >
            {business.name}
          </h2>
          {business.location ? (
            <p className="flex items-start gap-1.5 text-[13.5px] text-ink-muted">
              <PinIcon size={14} className="mt-0.5 shrink-0" />
              <span className="line-clamp-2 wrap-anywhere">
                {business.location}
              </span>
            </p>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <p className="px-1 text-[12.5px] font-semibold tracking-[0.14em] text-ink-muted uppercase">
            Prochain rendez-vous
          </p>
          {upcoming.status === "loading" ? (
            <Skeleton className="h-[132px] w-full rounded-[24px]" />
          ) : upcoming.status === "error" ? (
            <HubErrorNotice error={upcoming.error} onRetry={upcoming.reload}>
              Le prochain rendez-vous n’a pas pu être chargé.
            </HubErrorNotice>
          ) : upcoming.data.items[0] ? (
            <NextTicket
              business={business}
              appointment={upcoming.data.items[0]}
            />
          ) : (
            <div className="flex flex-1 flex-col justify-between gap-4 rounded-[24px] border border-dashed border-line-strong/70 px-5 py-5">
              <p className="text-[14.5px] leading-relaxed text-ink-soft">
                Aucun rendez-vous à venir pour l’instant.
              </p>
              <Link
                href={bookingHref(business.slug)}
                className="inline-flex h-11 w-fit items-center gap-2 rounded-full bg-ink px-5 text-[14.5px] font-medium text-paper-raised transition-colors hover:bg-[#382d27]"
              >
                Prendre rendez-vous <ArrowRightIcon size={16} />
              </Link>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <p className="px-1 text-[12.5px] font-semibold tracking-[0.14em] text-ink-muted uppercase">
            Fidélité
          </p>
          {loyalty.status === "loading" ? (
            <Skeleton className="h-[190px] w-full rounded-[24px] bg-ink/10" />
          ) : loyalty.status === "error" ? (
            <HubErrorNotice error={loyalty.error} onRetry={loyalty.reload}>
              Votre fidélité n’a pas pu être chargée.
            </HubErrorNotice>
          ) : (
            <Link
              href={hubHref.loyalty(id)}
              aria-label={`Ma fidélité chez ${business.name}`}
              className="block rounded-[24px] transition-transform duration-300 ease-soft hover:-translate-y-0.5"
            >
              <BalanceCard
                businessName={business.name}
                loyalty={loyalty.data}
                size="md"
              />
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 px-1">
        <QuickLink
          href={hubHref.appointments(id)}
          icon={<CalendarIcon size={16} />}
        >
          Tous mes rendez-vous
        </QuickLink>
        <QuickLink href={hubHref.loyalty(id)}>
          Récompenses et historique
        </QuickLink>
      </div>
    </section>
  );
}

function QuickLink({
  href,
  icon,
  children,
}: {
  href: Route;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group inline-flex h-10 items-center gap-2 rounded-full border border-line bg-paper px-4 text-[14px] font-medium text-ink transition-colors hover:border-line-strong"
    >
      {icon}
      {children}
      <ArrowRightIcon
        size={15}
        className="transition-transform duration-200 group-hover:translate-x-0.5"
      />
    </Link>
  );
}

/** The next appointment, as a ticket with its perforation. */
export function NextTicket({
  business,
  appointment,
}: {
  business: ClientHubBusinessDto;
  appointment: ClientHubAppointmentDto;
}) {
  const zone = business.timezone;
  const when = relativeDay(appointment.startsAt, zone);
  const status = appointmentStatus[appointment.status];

  return (
    <Link
      href={hubHref.appointment(business.businessId, appointment.id)}
      className="group block drop-shadow-[0_18px_30px_rgba(35,28,24,0.12)] transition-transform duration-300 ease-soft hover:-translate-y-0.5"
    >
      <span className="ticket flex flex-col bg-[linear-gradient(140deg,#fffcf8,#f7ede4)] [--notch:calc(100%_-_3rem)]">
        <span className="flex items-start gap-4 px-5 pt-5 pb-4">
          <DateTile iso={appointment.startsAt} timeZone={zone} size="lg" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="flex flex-wrap items-center gap-1.5">
              {when ? <Pill tone="accent">{when}</Pill> : null}
              {appointment.status !== "confirmed" ? (
                <Pill tone={status.tone}>{status.label}</Pill>
              ) : null}
            </span>
            <span className="font-display text-[25px] leading-[1.05] wrap-anywhere text-ink">
              {appointment.serviceName}
            </span>
            <span className="text-[13.5px] text-ink-soft first-letter:uppercase">
              {longDay(appointment.startsAt, zone)}
            </span>
          </span>
        </span>
        <span className="mx-5 border-t border-dashed border-line-strong/80" />
        <span className="flex h-12 items-center justify-between gap-3 px-5 text-[14px]">
          <span className="font-medium text-ink tabular-nums">
            {timeOf(appointment.startsAt, zone)} –{" "}
            {timeOf(appointment.endsAt, zone)}
          </span>
          <span
            className={cn(
              "flex items-center gap-1 text-ink-muted transition-colors group-hover:text-ink",
            )}
          >
            {duration(appointment.durationMinutes)}
            <ArrowRightIcon size={15} />
          </span>
        </span>
      </span>
    </Link>
  );
}

"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import {
  ArrowRightIcon,
  ChevronLeftIcon,
  ClockIcon,
  InfoIcon,
  PinIcon,
} from "@/components/ui/icons";
import { formatPrice } from "@/features/agenda/client/money";
import type { ClientHubBusinessDto } from "@/features/client-hub/types";

import { fetchAppointment } from "../client/api";
import {
  appointmentStatus,
  duration,
  longDay,
  relativeDay,
  timeOf,
} from "../client/format";
import { useHubRead } from "../client/session";
import { DateTile, HubErrorNotice, Loading, Pill, Skeleton } from "./hub-parts";
import { HubPage, bookingHref, hubHref } from "./hub-shell";

export function HubAppointmentDetail({
  businessId,
  appointmentId,
}: {
  businessId: string;
  appointmentId: string;
}) {
  return (
    <HubPage section="appointments" businessId={businessId}>
      {({ business }) => (
        <Detail business={business!} appointmentId={appointmentId} />
      )}
    </HubPage>
  );
}

function Detail({
  business,
  appointmentId,
}: {
  business: ClientHubBusinessDto;
  appointmentId: string;
}) {
  const id = business.businessId;
  const read = useHubRead(`${id}:${appointmentId}`, (signal) =>
    fetchAppointment(id, appointmentId, signal),
  );
  const back = (
    <Link
      href={hubHref.appointments(id)}
      className="-ml-1 flex w-fit items-center gap-1 rounded-lg px-1 py-1 text-[14px] text-ink-soft hover:text-ink"
    >
      <ChevronLeftIcon size={16} /> Mes rendez-vous
    </Link>
  );

  if (read.status === "loading") {
    return (
      <>
        {back}
        <Loading label="Chargement du rendez-vous…">
          <Skeleton className="h-10 w-2/3 rounded-2xl" />
          <Skeleton className="h-[220px] w-full rounded-[30px]" />
          <Skeleton className="h-28 w-full rounded-[26px]" />
        </Loading>
      </>
    );
  }
  if (read.status === "error") {
    return (
      <>
        {back}
        {read.error.code === "client_hub_not_found" ? (
          <div className="flex flex-col items-start gap-3 rounded-[28px] border border-line bg-paper-raised px-6 py-8">
            <h1 className="font-display text-[30px] leading-tight text-ink">
              Rendez-vous introuvable
            </h1>
            <p className="max-w-prose text-[15px] leading-relaxed text-ink-soft">
              Ce rendez-vous n’existe pas ou n’est pas accessible depuis votre
              espace.
            </p>
          </div>
        ) : (
          <HubErrorNotice error={read.error} onRetry={read.reload}>
            Ce rendez-vous n’a pas pu être chargé.
          </HubErrorNotice>
        )}
      </>
    );
  }

  const appointment = read.data;
  // The appointment's own business record (its name, place and policy as
  // they are now), read with it.
  const place = appointment.business;
  const zone = place.timezone;
  const status = appointmentStatus[appointment.status];
  const when =
    appointment.status === "confirmed"
      ? relativeDay(appointment.startsAt, zone)
      : null;
  const upcoming = appointment.status === "confirmed";

  return (
    <>
      {back}
      <article
        className="flex flex-col gap-5"
        aria-labelledby="appointment-title"
      >
        <div className="grain relative isolate flex animate-rise flex-col gap-6 overflow-hidden rounded-[32px] border border-line bg-[linear-gradient(150deg,#fffcf8_0%,#f6ebe1_100%)] p-5 sm:p-8">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-28 -right-24 -z-10 size-80 rounded-full bg-[radial-gradient(circle_at_center,rgba(151,73,58,0.16),transparent_62%)]"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={status.tone}>{status.label}</Pill>
            {when ? <Pill tone="accent">{when}</Pill> : null}
          </div>
          <div className="flex items-start gap-4 sm:gap-6">
            <DateTile
              iso={appointment.startsAt}
              timeZone={zone}
              size="lg"
              muted={!upcoming && appointment.status !== "completed"}
            />
            <div className="flex min-w-0 flex-col gap-2">
              <h1
                id="appointment-title"
                className="font-display text-[34px] leading-[1.02] tracking-[-0.015em] wrap-anywhere text-ink sm:text-[44px]"
              >
                {appointment.serviceName}
              </h1>
              <p className="text-[15px] text-ink-soft first-letter:uppercase">
                {longDay(appointment.startsAt, zone)}
              </p>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[22px] border border-line bg-line sm:grid-cols-3">
            <Fact label="Horaire">
              {timeOf(appointment.startsAt, zone)} –{" "}
              {timeOf(appointment.endsAt, zone)}
            </Fact>
            <Fact label="Durée">{duration(appointment.durationMinutes)}</Fact>
            <Fact label="Prix" wide>
              {formatPrice(appointment.priceCents, appointment.currency)}
            </Fact>
          </dl>
        </div>

        <section
          aria-label="Établissement"
          className="flex flex-col gap-4 rounded-[28px] border border-line bg-paper-raised p-5 sm:p-6"
        >
          <div className="flex flex-col gap-1">
            <p className="text-[12.5px] font-semibold tracking-[0.14em] text-ink-muted uppercase">
              Établissement
            </p>
            <p className="font-display text-[26px] leading-tight wrap-anywhere text-ink">
              {place.name}
            </p>
            {place.location ? (
              <p className="flex items-start gap-1.5 text-[14.5px] wrap-anywhere text-ink-soft">
                <PinIcon size={16} className="mt-0.5 shrink-0" />{" "}
                {place.location}
              </p>
            ) : null}
          </div>
          <p className="flex items-start gap-2 rounded-2xl bg-sand/60 px-4 py-3 text-[14px] leading-relaxed text-ink-soft">
            <InfoIcon size={17} className="mt-0.5 shrink-0" />
            Pour déplacer ou annuler ce rendez-vous, contactez directement{" "}
            {place.name}. Rien ne peut être modifié depuis votre espace.
          </p>
          {place.cancellationPolicy ? (
            <div className="flex flex-col gap-1.5">
              <p className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
                <ClockIcon size={16} /> Conditions d’annulation
              </p>
              <p className="text-[14px] leading-relaxed wrap-anywhere whitespace-pre-line text-ink-soft">
                {place.cancellationPolicy}
              </p>
            </div>
          ) : null}
          <Link
            href={bookingHref(place.slug)}
            className="inline-flex h-11 w-fit items-center gap-2 rounded-full border border-line px-5 text-[14.5px] font-medium text-ink transition-colors hover:border-line-strong"
          >
            {upcoming ? "Réserver un autre créneau" : "Reprendre rendez-vous"}{" "}
            <ArrowRightIcon size={16} />
          </Link>
        </section>

        <p className="text-[12.5px] text-ink-muted">
          Heures de {place.name} ({zone}).
        </p>
      </article>
    </>
  );
}

function Fact({
  label,
  children,
  wide,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className={
        wide
          ? "col-span-2 bg-paper-raised px-4 py-3.5 sm:col-span-1"
          : "bg-paper-raised px-4 py-3.5"
      }
    >
      <dt className="text-[12.5px] text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-[16px] font-semibold text-ink tabular-nums">
        {children}
      </dd>
    </div>
  );
}

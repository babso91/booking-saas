"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  BanIcon,
  CheckIcon,
  ClockIcon,
  GiftIcon,
  MailIcon,
  UserOffIcon,
} from "@/components/ui/icons";
import {
  formatDayMonth,
  formatWeekdayShort,
} from "@/features/agenda/client/dates";
import { formatPrice } from "@/features/agenda/client/money";
import type {
  AppointmentTimelineEvent,
  ClientProfileDto,
  ClientTimelineEvent,
  EmailTimelineEvent,
  LoyaltyTimelineEvent,
} from "@/features/crm/types";
import { cn } from "@/lib/cn";

import {
  appointmentStatusCopy,
  emailStatusLabels,
  emailTitles,
  loyaltyTitles,
  pointsLabel,
  sourceLabel,
  type StatusTone,
} from "../client/copy";
import { agendaDayHref, dayMonthYear, timeLabel } from "../client/format";
import { contactAtTheTime, groupTimeline } from "../client/timeline";
import type { TimelineState } from "./client-profile";
import { CrmError } from "./crm-error";

type CurrentClient = ClientProfileDto["client"];

/**
 * The relationship history, newest first, grouped by business-local day
 * with a heading per year. Appointments are cards; loyalty and emails are
 * lighter lines. Older pages load on demand; what is shown is never
 * replaced by a page that fails.
 */
export function Timeline({
  state,
  client,
  timezone,
  onLoadOlder,
  onRetry,
}: {
  state: TimelineState;
  client: CurrentClient;
  timezone: string;
  onLoadOlder: () => void;
  onRetry: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownCount = useRef(0);
  const [announce, setAnnounce] = useState("");

  // After "Afficher plus ancien", the keyboard continues on the first new
  // event, and the number added is announced.
  useEffect(() => {
    const previous = shownCount.current;
    shownCount.current = state.events.length;
    if (previous === 0 || state.events.length <= previous) return;
    const first = state.events[previous];
    if (first) {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-event="${CSS.escape(first.id)}"]`)
        ?.focus();
    }
    const added = state.events.length - previous;
    setAnnounce(
      `${added} événement${added > 1 ? "s" : ""} plus ancien${added > 1 ? "s" : ""} ajouté${added > 1 ? "s" : ""}.`,
    );
  }, [state.events]);

  const years = groupTimeline(state.events);

  return (
    <section
      aria-labelledby="client-history"
      className="flex min-w-0 flex-col gap-4 rounded-3xl border border-line bg-paper-raised px-4 py-4 sm:px-6 lg:py-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="client-history"
          ref={headingRef}
          tabIndex={-1}
          className="sr-only font-display text-[26px] leading-tight text-ink focus:outline-none lg:not-sr-only"
        >
          Historique
        </h2>
        <p className="text-[12.5px] text-ink-muted">Heures de {timezone}</p>
      </div>

      {state.status === "loading" ? (
        <TimelineSkeleton />
      ) : state.status === "error" && state.error ? (
        <CrmError error={state.error} onRetry={onRetry}>
          {state.error.code === "unauthenticated"
            ? undefined
            : "L’historique n’a pas pu être chargé."}
        </CrmError>
      ) : state.events.length === 0 ? (
        <p className="rounded-2xl bg-sand/50 px-4 py-4 text-[14.5px] text-ink-soft">
          Pas encore d’historique. Ses rendez-vous passés apparaîtront ici.
        </p>
      ) : (
        <div ref={listRef} className="flex flex-col gap-2">
          {years.map((year, index) => (
            <div key={year.year} className="flex flex-col">
              {index > 0 || years.length > 1 ? (
                <h3 className="flex items-center gap-3 py-2 font-display text-[22px] text-ink-soft after:h-px after:flex-1 after:bg-line">
                  {year.year}
                </h3>
              ) : null}
              <ol className="flex flex-col">
                {year.days.map((day) => (
                  <li
                    key={day.date}
                    className="grid grid-cols-1 gap-2 py-2.5 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-4"
                  >
                    <DayLabel date={day.date} />
                    <ol className="flex min-w-0 flex-col gap-2 border-l border-line pl-4">
                      {day.events.map((event) => (
                        <li
                          key={event.id}
                          data-event={event.id}
                          tabIndex={-1}
                          className="relative rounded-xl focus:outline-2 focus:outline-offset-2 focus:outline-accent"
                        >
                          <TimelineEntry event={event} client={client} />
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}

      <p className="sr-only" aria-live="polite">
        {announce}
      </p>

      {state.status === "ready" && typeof state.more === "object" ? (
        <CrmError error={state.more} onRetry={onLoadOlder}>
          {state.more.code === "unauthenticated"
            ? undefined
            : "La suite de l’historique n’a pas pu être chargée. Ce qui est affiché reste valable."}
        </CrmError>
      ) : null}

      {state.status === "ready" && (state.nextCursor || state.pages > 1) ? (
        <div className="flex flex-col items-center gap-2 pt-1 sm:flex-row sm:justify-center sm:gap-4">
          {state.nextCursor ? (
            <Button
              variant="secondary"
              size="md"
              state={state.more === "loading" ? "loading" : "idle"}
              loadingLabel="Chargement…"
              onClick={onLoadOlder}
            >
              Afficher plus ancien
            </Button>
          ) : (
            <p className="text-[13.5px] text-ink-muted">
              Début de l’historique.
            </p>
          )}
          {state.pages > 1 ? (
            <button
              type="button"
              onClick={() => {
                headingRef.current?.scrollIntoView({ block: "start" });
                headingRef.current?.focus();
              }}
              className="cursor-pointer text-[13.5px] text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink"
            >
              Revenir en haut
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function DayLabel({ date }: { date: string }) {
  return (
    <time
      dateTime={date}
      className="flex items-baseline gap-1.5 text-[13px] text-ink-muted sm:flex-col sm:items-start sm:gap-0 sm:pt-1.5"
    >
      <span className="font-display text-[20px] leading-none text-ink sm:text-[24px]">
        {formatDayMonth(date)}
      </span>
      <span>{formatWeekdayShort(date)}</span>
    </time>
  );
}

/** One persisted fact; a kind this screen does not know yet is skipped. */
function TimelineEntry({
  event,
  client,
}: {
  event: ClientTimelineEvent;
  client: CurrentClient;
}) {
  switch (event.kind) {
    case "appointment":
      return <AppointmentEntry event={event} client={client} />;
    case "loyalty":
      return <LoyaltyEntry event={event} />;
    case "email":
      return <EmailEntry event={event} />;
    default:
      return null;
  }
}

const toneStyles: Record<
  StatusTone,
  { pill: string; dot: string; icon: typeof CheckIcon }
> = {
  done: {
    pill: "bg-success-soft text-success",
    dot: "border-success bg-success",
    icon: CheckIcon,
  },
  cancelled: {
    pill: "bg-sand text-ink-muted",
    dot: "border-line-strong bg-paper-raised",
    icon: BanIcon,
  },
  absent: {
    pill: "bg-warning-soft text-warning",
    dot: "border-warning bg-warning-soft",
    icon: UserOffIcon,
  },
  pending: {
    pill: "bg-accent-soft text-accent-strong",
    dot: "border-accent bg-paper-raised",
    icon: ClockIcon,
  },
};

function Dot({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute top-[15px] -left-[21px] size-[9px] rounded-full border-2",
        className,
      )}
    />
  );
}

function AppointmentEntry({
  event,
  client,
}: {
  event: AppointmentTimelineEvent;
  client: CurrentClient;
}) {
  const { appointment } = event;
  const status = appointmentStatusCopy[appointment.status];
  const tone = toneStyles[status.tone];
  const Icon = tone.icon;
  const start = timeLabel(appointment.startsAt);
  const end = timeLabel(appointment.endsAt);
  const price = formatPrice(
    appointment.price.amountCents,
    appointment.price.currency,
  );
  const contact = contactAtTheTime(appointment.contact, client);

  // A cancelled or missed appointment is dated by its scheduled time: the
  // moment it was cancelled is not known, and never presented.
  const when =
    appointment.status === "cancelled"
      ? `Prévu à ${start}`
      : `${start} – ${end}`;
  const details = [
    when,
    appointment.status === "completed" ? price : null,
    appointment.status === "confirmed" ? `${price} prévus` : null,
    sourceLabel(appointment.source),
  ].filter(Boolean);

  return (
    <article
      className={cn(
        "flex flex-col gap-1 rounded-2xl border px-3.5 py-3",
        appointment.status === "cancelled"
          ? "border-dashed border-line-strong/70 bg-transparent"
          : "border-line bg-paper",
      )}
    >
      <Dot className={tone.dot} />
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h4
          className={cn(
            "text-[15px] font-semibold",
            appointment.status === "cancelled" ? "text-ink-soft" : "text-ink",
          )}
        >
          {appointment.service.name}
        </h4>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[12.5px] font-medium",
            tone.pill,
          )}
        >
          <Icon size={13} strokeWidth={2} />
          {status.label}
        </span>
      </div>
      <p className="text-[13.5px] text-ink-muted">{details.join(" · ")}</p>
      {appointment.status === "cancelled" && appointment.cancellationReason ? (
        <p className="text-[13.5px] break-words text-ink-soft">
          « {appointment.cancellationReason} »
        </p>
      ) : null}
      {appointment.status === "completed" && appointment.completedAt ? (
        <p className="text-[12.5px] text-ink-muted">
          Marqué terminé le {dayMonthYear(appointment.completedAt)} à{" "}
          {timeLabel(appointment.completedAt)}
        </p>
      ) : null}
      {contact ? (
        <p className="text-[12.5px] break-words text-ink-muted">
          Contact indiqué pour ce rendez-vous : {contact}
        </p>
      ) : null}
      {appointment.status === "confirmed" ? (
        <Link
          href={agendaDayHref(appointment.startsAt)}
          className="w-fit text-[13px] font-medium text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink"
        >
          Indiquer le statut dans l’agenda
        </Link>
      ) : (
        <Link
          href={agendaDayHref(appointment.startsAt)}
          className="w-fit text-[12.5px] text-ink-muted underline decoration-line underline-offset-4 hover:text-ink-soft"
        >
          Voir la journée dans l’agenda
        </Link>
      )}
    </article>
  );
}

function LoyaltyEntry({ event }: { event: LoyaltyTimelineEvent }) {
  const { entry } = event;
  const title =
    entry.redemption && entry.type === "reward_redeemed"
      ? `Récompense échangée : ${entry.redemption.rewardName ?? "récompense"}`
      : loyaltyTitles[entry.type];
  return (
    <div className="flex gap-2.5 py-1">
      <Dot className="border-accent bg-paper-raised" />
      <GiftIcon size={16} className="mt-0.5 shrink-0 text-accent" />
      <div className="flex min-w-0 flex-col">
        <p className="text-[14px] font-medium text-ink-soft">
          {title}{" "}
          <span className="font-semibold text-ink tabular-nums">
            {pointsLabel(entry.pointsDelta)}
          </span>
        </p>
        {entry.reason ? (
          <p className="text-[13px] break-words text-ink-muted">
            {entry.reason}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function EmailEntry({ event }: { event: EmailTimelineEvent }) {
  const { email } = event;
  const status =
    email.status === "sent" && email.sentAt
      ? `Envoyé le ${dayMonthYear(email.sentAt)} à ${timeLabel(email.sentAt)}`
      : emailStatusLabels[email.status];
  return (
    <div className="flex gap-2.5 py-0.5">
      <Dot className="top-[11px] -left-[20px] size-[7px] border-line-strong bg-paper-raised" />
      <MailIcon size={15} className="mt-0.5 shrink-0 text-ink-muted" />
      <div className="flex min-w-0 flex-col">
        <p className="text-[13.5px] text-ink-soft">{emailTitles[email.type]}</p>
        <p className="text-[12.5px] break-words text-ink-muted">
          {status} · {email.recipientEmail}
        </p>
      </div>
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <span className="sr-only" role="status">
        Chargement de l’historique…
      </span>
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-1 gap-2 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-4"
        >
          <span className="h-5 w-16 animate-pulse rounded-full bg-sand" />
          <span className="h-[4.5rem] animate-pulse rounded-2xl bg-sand/60" />
        </div>
      ))}
    </div>
  );
}

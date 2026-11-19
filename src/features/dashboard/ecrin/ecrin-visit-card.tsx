import Link from "next/link";
import { useLayoutEffect, useRef, type RefObject } from "react";

import { ArrowRightIcon, NoteIcon } from "@/components/ui/icons";
import { Sheet } from "@/components/ui/sheet";
import {
  dateOf,
  formatDuration,
  formatFullDate,
  timeOf,
} from "@/features/agenda/client/dates";
import { formatPrice } from "@/features/agenda/client/money";
import { timeWithOccurrence } from "@/features/agenda/client/occurrence";
import type { Zone } from "@/features/agenda/client/zone";
import { StatusBadge } from "@/features/agenda/components/status-badge";
import type { AgendaAppointmentDto } from "@/features/agenda/data/agenda";

export function visitHref(
  appointment: AgendaAppointmentDto,
  previewQuery?: string,
) {
  const date = dateOf(appointment.localStartsAt);
  if (previewQuery === undefined) {
    return { pathname: "/app", query: { date, rdv: appointment.id } } as const;
  }
  return {
    pathname: "/apercu/ecrin/agenda",
    query: {
      ...Object.fromEntries(new URLSearchParams(previewQuery)),
      jour: date,
      vue: "jour",
      rdv: appointment.id,
    },
  } as const;
}

export function EcrinVisitCard({
  appointment,
  zone,
  onClose,
  source,
  returnFocus,
  previewQuery,
}: {
  appointment: AgendaAppointmentDto;
  zone: Zone | null;
  onClose: () => void;
  source: RefObject<HTMLElement | null>;
  returnFocus: RefObject<HTMLElement | null>;
  previewQuery?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const travel = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (
      !panel?.animate ||
      document.documentElement.dataset.motion !== "standard" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const box = panel.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const tile = source.current?.getBoundingClientRect();
    const fromTile =
      tile &&
      tile.height > 0 &&
      tile.bottom > 0 &&
      tile.top < window.innerHeight;
    const scale = fromTile
      ? Math.min(1, Math.max(0.58, tile.width / box.width))
      : 0.94;
    const x = fromTile
      ? tile.left + tile.width / 2 - (box.left + box.width / 2)
      : 0;
    const y = fromTile ? tile.top - box.top : Math.min(100, box.height * 0.25);
    const cut = fromTile
      ? Math.max(0, 100 * (1 - tile.height / (box.height * scale)))
      : 20;
    const animation = panel.animate(
      [
        {
          transform: `translate(${x}px, ${y}px) scale(${scale})`,
          clipPath: `inset(0 0 ${cut}% round 26px)`,
          opacity: 0.55,
        },
        {
          transform: "translate(0, 0) scale(1)",
          clipPath: "inset(0 0 0% round 28px)",
          opacity: 1,
        },
      ],
      {
        duration: 520,
        easing: "cubic-bezier(.22,.74,.18,1)",
        fill: "backwards",
      },
    );
    travel.current = animation;
    return () => {
      animation.cancel();
      travel.current = null;
    };
  }, [source]);

  const close = () => {
    const animation = travel.current;
    if (
      !animation ||
      document.documentElement.dataset.motion !== "standard" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      onClose();
      return;
    }
    if (animation.playbackRate < 0) return;
    panelRef.current?.setAttribute("data-closing", "");
    animation.onfinish = onClose;
    animation.updatePlaybackRate(-1.65);
    animation.play();
  };

  const { localStartsAt, localEndsAt, client, service, options } = appointment;
  const date = dateOf(localStartsAt);
  const finishDate = dateOf(localEndsAt);
  const start = timeWithOccurrence(
    timeOf(localStartsAt),
    appointment.startOccurrence,
    date,
    zone,
  );
  return (
    <Sheet
      open
      onClose={close}
      panelRef={panelRef}
      placement="center"
      panelClassName="ecrin-visit-sheet"
      returnFocus={returnFocus}
      title={client.displayName}
      footer={
        <Link
          href={visitHref(appointment, previewQuery)}
          className="flex min-h-12 items-center justify-between gap-4 rounded-full bg-signature px-5 font-medium text-on-signature focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Ouvrir dans l’agenda <ArrowRightIcon size={18} />
        </Link>
      }
    >
      <div className="flex flex-col gap-4 text-ink">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadge status={appointment.status} compact />
          <span className="text-sm text-ink-soft">
            {appointment.source === "public"
              ? "Réservé en ligne"
              : "Ajouté par toi"}
          </span>
        </div>
        <div className="ecrin-visit-time">
          <p className="font-engraved text-base first-letter:uppercase">
            {formatFullDate(date)}
          </p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-light tabular-nums">
            <time
              dateTime={appointment.startsAt}
              className={
                appointment.startOccurrence
                  ? "text-2xl"
                  : "text-[42px] leading-[1.1]"
              }
            >
              {start}
            </time>
            <span className="text-base text-ink-soft">
              à <time dateTime={appointment.endsAt}>{timeOf(localEndsAt)}</time>
              {finishDate !== date && ` le ${formatFullDate(finishDate)}`}
            </span>
          </p>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-engraved text-[21px] leading-tight [overflow-wrap:anywhere]">
              {service.name}
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              {formatDuration(appointment.durationMinutes)}
            </p>
          </div>
          <p
            className="shrink-0 text-lg tabular-nums"
            aria-label={`Prix convenu : ${formatPrice(appointment.priceCents, appointment.currency)}`}
          >
            {formatPrice(appointment.priceCents, appointment.currency)}
          </p>
        </div>
        {options.length > 0 && (
          <dl className="grid gap-2 border-t border-line pt-3 text-sm">
            {options.map((option) => (
              <div key={option.optionId}>
                <dt className="text-ink-soft">{option.question}</dt>
                <dd>{option.label}</dd>
              </div>
            ))}
          </dl>
        )}
        {appointment.internalNotes?.trim() && (
          <div className="border-t border-line pt-3">
            <p className="flex items-center gap-2 text-sm text-ink-soft">
              <NoteIcon size={15} />
              Note interne
            </p>
            <p className="mt-1 whitespace-pre-line text-[15px] [overflow-wrap:anywhere]">
              {appointment.internalNotes}
            </p>
          </div>
        )}
      </div>
    </Sheet>
  );
}

"use client";

import {
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from "react";

import { useLate } from "@/components/ui/motion";
import { formatPrice } from "@/features/agenda/client/money";
import { longDescription } from "@/features/catalog/description";
import { durationLabel } from "@/features/services/client/service-form";

import { deviceTimeZone, zoneCity } from "../client/business-time";
import type { BookableService, SlotsState } from "../client/use-booking-flow";

// Small presentation pieces shared by the steps of the functional booking
// page. Visual only: every rule lives in useBookingFlow.

/**
 * Where she receives and how to reach her, as her site publishes it
 * ("Infos pratiques"): shown before and after booking (Higani 56, 69, 77).
 * Absent on her plain booking page: her general location stands in.
 */
export type BookingPlace = {
  address: string;
  area: string;
  instructions: string;
  phone: string;
  email: string;
  /** Her conditions (Higani point 6); absent from older publications. */
  lateness?: string;
  noShow?: string;
  companions?: string;
};

/**
 * Her conditions, read before she commits (Higani point 6): her
 * cancellation terms (her business), then what her site says about being
 * late, a missed visit, companions and what to do before coming. Only what
 * she wrote; no deposit until one is really taken.
 */
export function conditionRows(
  cancellationPolicy: string | null,
  place: BookingPlace | undefined,
): [string, string][] {
  return (
    [
      ["Annulation", cancellationPolicy],
      ["Retard", place?.lateness],
      ["Rendez-vous manqué", place?.noShow],
      ["Accompagnants", place?.companions],
      ["Avant de venir", place?.instructions],
    ] as const
  ).flatMap(([label, text]) =>
    text?.trim() ? [[label, text.trim()] as [string, string]] : [],
  );
}

/** Her address, else her area, else her general location. */
export const placeLine = (
  place: BookingPlace | undefined,
  location: string | null,
) => place?.address.trim() || place?.area.trim() || location?.trim() || null;

// Its words stay a link's size; the finger gets 45 px (Higani point 201):
// an invisible band above and below takes the tap, the layout is untouched.
export const linkAction =
  "relative cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4 after:absolute after:-inset-x-1 after:-inset-y-3 after:content-[''] disabled:cursor-not-allowed disabled:opacity-50";

export const serviceLine = (
  durationMinutes: number,
  priceCents: number,
  currency: string,
) => `${durationLabel(durationMinutes)} · ${formatPrice(priceCents, currency)}`;

/** What an answer adds: "+15,00 € · +30 min", or "Inclus". */
export function choiceLine(
  choice: { priceDeltaCents: number; durationDeltaMinutes: number },
  currency: string,
) {
  const parts = [
    choice.priceDeltaCents > 0
      ? `+${formatPrice(choice.priceDeltaCents, currency)}`
      : null,
    choice.durationDeltaMinutes > 0
      ? `+${durationLabel(choice.durationDeltaMinutes)}`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Inclus";
}

/**
 * A service in the list: its price and duration, "dès" when its required
 * groups can only add to them (their smallest answers). Read from her
 * catalogue for the list only; what is booked is always the server's quote.
 */
export function serviceFromLine(service: BookableService) {
  let price = service.priceCents;
  let minutes = service.durationMinutes;
  for (const option of service.options) {
    if (!option.required) continue;
    price += Math.min(...option.choices.map((item) => item.priceDeltaCents));
    minutes += Math.min(
      ...option.choices.map((item) => item.durationDeltaMinutes),
    );
  }
  const varies = service.options.some((option) =>
    option.choices.some(
      (item) => item.priceDeltaCents > 0 || item.durationDeltaMinutes > 0,
    ),
  );
  const line = serviceLine(minutes, price, service.currency);
  return varies ? `dès ${line}` : line;
}

type Quote = Extract<SlotsState, { status: "ready" }>["quote"];

/**
 * The quote to show: the server's, kept while another day loads (Higani:
 * « une micro seconde ça écrit durée, ça fait un saut »). A day does not
 * change her price; the new quote replaces it as soon as it is there.
 */
function useShownQuote(slots: SlotsState) {
  const [kept, setKept] = useState<Quote | null>(
    slots.status === "ready" ? slots.quote : null,
  );
  if (slots.status === "ready" && slots.quote !== kept) setKept(slots.quote);
  if (slots.status === "ready") return slots.quote;
  return slots.status === "loading" ? kept : null;
}

/** The server's quote for her answers, or where it stands. */
export function QuoteLine({ slots }: { slots: SlotsState }) {
  return <QuoteFigure quote={useShownQuote(slots)} status={slots.status} />;
}

function QuoteFigure({
  quote,
  status,
}: {
  quote: Quote | null;
  status: SlotsState["status"];
}) {
  // The first quote is usually there at once: « Calcul… » only for a slow
  // one, the price's line held meanwhile (nothing flashes, nothing jumps).
  const slow = useLate(status === "loading" && !quote);
  if (quote)
    return (
      <p className="text-[17px] font-semibold text-ink tabular-nums">
        {serviceLine(quote.durationMinutes, quote.priceCents, quote.currency)}
      </p>
    );
  if (status === "loading" && !slow)
    return <p className="text-[17px] font-semibold">&nbsp;</p>;
  if (status === "loading")
    return (
      <p role="status" className="text-[15px] text-ink-muted">
        Calcul du prix et de la durée…
      </p>
    );
  return <p className="text-[15px] text-ink-muted">—</p>;
}

/**
 * The answers as the server priced them (a quote or a booking), each with
 * what it adds (Higani point 55): « Volume (+15,00 € · +30 min) ».
 */
export function answerRows(
  options: {
    question: string;
    label: string;
    priceDeltaCents?: number;
    durationDeltaMinutes?: number;
  }[],
  currency?: string,
): [string, ReactNode][] {
  return options.map((option) => {
    const adds =
      currency && (option.priceDeltaCents || option.durationDeltaMinutes)
        ? ` (${choiceLine(
            {
              priceDeltaCents: option.priceDeltaCents ?? 0,
              durationDeltaMinutes: option.durationDeltaMinutes ?? 0,
            },
            currency,
          )})`
        : "";
    return [option.question, `${option.label}${adds}`];
  });
}

/**
 * The server's quote, line by line (Higani point 55): the service, what
 * each answer adds, the total. Only the total when no answer adds anything.
 */
export function QuoteBreakdown({
  slots,
  serviceName,
}: {
  slots: SlotsState;
  serviceName: string;
}) {
  const quote = useShownQuote(slots);
  if (!quote) return <QuoteFigure quote={null} status={slots.status} />;
  const adding = quote.options.filter(
    (option) => option.priceDeltaCents || option.durationDeltaMinutes,
  );
  if (!adding.length)
    return <QuoteFigure quote={quote} status={slots.status} />;
  const basePrice =
    quote.priceCents -
    adding.reduce((sum, option) => sum + option.priceDeltaCents, 0);
  const baseMinutes =
    quote.durationMinutes -
    adding.reduce((sum, option) => sum + option.durationDeltaMinutes, 0);
  const row = "flex items-baseline justify-between gap-4";
  return (
    <dl className="flex flex-col gap-1.5 text-[14.5px] tabular-nums">
      <div className={row}>
        <dt className="min-w-0 wrap-anywhere text-ink-soft">{serviceName}</dt>
        <dd className="shrink-0 text-ink-soft">
          {serviceLine(baseMinutes, basePrice, quote.currency)}
        </dd>
      </div>
      {adding.map((option) => (
        <div key={option.optionId} className={row}>
          <dt className="min-w-0 wrap-anywhere text-ink-soft">
            {option.question} : {option.label}
          </dt>
          <dd className="shrink-0 text-ink-soft">
            {choiceLine(option, quote.currency)}
          </dd>
        </div>
      ))}
      <div className={`${row} mt-1 border-t border-line pt-2`}>
        <dt className="font-semibold text-ink">Total</dt>
        <dd className="shrink-0 text-[17px] font-semibold text-ink">
          {serviceLine(quote.durationMinutes, quote.priceCents, quote.currency)}
        </dd>
      </div>
    </dl>
  );
}

/** Her conditions, as a list (review, and on demand before). */
export function ConditionsList({
  conditions,
}: {
  conditions: [string, string][];
}) {
  return (
    <dl className="flex flex-col gap-3 text-[14px]">
      {conditions.map(([label, text]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="font-medium text-ink">{label}</dt>
          <dd className="whitespace-pre-line wrap-anywhere text-ink-soft">
            {text}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Her conditions one tap away before she gives her details (Higani point
 * 56): « Conditions : annulation, retard », opened on demand.
 */
export function ConditionsPeek({
  conditions,
}: {
  conditions: [string, string][];
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!conditions.length) return null;
  const names = conditions.map(([label]) => label.toLowerCase()).join(", ");
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className={`${linkAction} min-h-11 self-start`}
      >
        Conditions : {names}
      </button>
      {open ? (
        <div id={id}>
          <ConditionsList conditions={conditions} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Its description, a few lines first, « Lire la suite » for the rest
 * (Higani point 35). Her line breaks are kept.
 */
export function useFoldedText(text: string | null | undefined) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = longDescription(text);
  return {
    id,
    folded: long && !open,
    toggle: long ? (
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className={`${linkAction} min-h-11 self-start`}
      >
        {open ? "Réduire" : "Lire la suite"}
      </button>
    ) : null,
  };
}

const STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmé",
  cancelled: "Annulé",
  completed: "Terminé",
  no_show: "Absence notée",
};

export const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;

/** A step title, focused when its step opens (keyboard and screen readers). */
const STEP_NAMES = {
  service: "la prestation",
  options: "vos options",
  slot: "le créneau",
  contact: "vos coordonnées",
  review: "la vérification",
} as const;

/**
 * What is left after this step, said with its place (Higani point 65):
 * « Ensuite : vos coordonnées, puis la vérification », « Dernière étape ».
 */
export function whatsLeft(after: readonly (keyof typeof STEP_NAMES)[]) {
  const names = after.map((step) => STEP_NAMES[step]);
  if (!names.length) return "Dernière étape";
  return names.length === 1
    ? `Ensuite : ${names[0]}`
    : `Ensuite : ${names.slice(0, -1).join(", ")}, puis ${names.at(-1)}`;
}

export function StepHeading({
  step,
  total,
  left,
  children,
  headingRef,
}: {
  step?: number;
  total?: number;
  /** What is left (whatsLeft). */
  left?: string;
  children: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="flex flex-col gap-1">
      {step && total ? (
        <p className="text-[13px] font-medium text-ink-muted">
          Étape {step} sur {total}
          {left ? <span className="font-normal"> · {left}</span> : null}
        </p>
      ) : null}
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="font-display text-[28px] leading-tight text-ink focus:outline-none sm:text-[32px]"
      >
        {children}
      </h2>
    </div>
  );
}

/** Label / value rows (recap, confirmation). */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-paper-raised">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
        >
          <dt className="text-[13.5px] text-ink-muted">{label}</dt>
          <dd className="min-w-0 text-[15px] font-medium wrap-anywhere text-ink sm:text-right">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const noSubscription = () => () => {};

/**
 * Says whose clock the times follow. When the customer's device is on
 * another zone, says so plainly: the times are the business's.
 */
export function TimeZoneNote({ timezone }: { timezone: string }) {
  // Read on the client only (the server has no idea of the device's zone).
  const device = useSyncExternalStore(
    noSubscription,
    deviceTimeZone,
    () => null,
  );
  const elsewhere = device !== null && device !== timezone;
  return (
    <p className="text-[13.5px] leading-snug text-ink-muted">
      Heures de l’établissement, heure de {zoneCity(timezone)} ({timezone}).
      {elsewhere
        ? " Votre appareil est réglé sur un autre fuseau horaire : les heures indiquées ici restent celles de l’établissement."
        : null}
    </p>
  );
}

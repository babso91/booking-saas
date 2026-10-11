"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  CalendarIcon,
  ChevronLeftIcon,
  CopyIcon,
  MailIcon,
  PhoneIcon,
} from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { formatPrice } from "@/features/agenda/client/money";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import {
  getClientProfileAction,
  listClientTimelineAction,
} from "@/features/crm/actions/crm";
import type {
  AppointmentSummaryDto,
  ClientProfileDto,
  ClientTimelineEvent,
} from "@/features/crm/types";
import { cn } from "@/lib/cn";
import { useMediaQuery } from "@/lib/hooks/use-media-query";

import { appendUnique } from "../client/directory-state";
import {
  agendaDayHref,
  dateWithYear,
  dayAndTime,
  dayMonthYear,
  longDate,
  monthAndYear,
  monthShort,
  timeLabel,
  weekdayShort,
} from "../client/format";
import { CrmError } from "./crm-error";
import { Monogram } from "./monogram";
import { Timeline } from "./timeline";

const TIMELINE_PAGE = 20;
const DIRECTORY = "/app/clients";
const DIRECTORY_KEY = "crm:directory";

const noSubscription = () => () => {};

/** Back to the list as it was (search, filter, sort), when known. */
function savedDirectory() {
  try {
    const saved = window.sessionStorage.getItem(DIRECTORY_KEY);
    return saved?.startsWith(DIRECTORY) ? saved : DIRECTORY;
  } catch {
    return DIRECTORY; // storage unavailable
  }
}

type Load<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: UiError };

export type TimelineState = {
  status: "loading" | "ready" | "error";
  events: ClientTimelineEvent[];
  nextCursor: string | null;
  error: UiError | null;
  /** "Afficher plus ancien" in progress, or its failure. */
  more: "idle" | "loading" | UiError;
  /** Pages shown so far (1 after the first read). */
  pages: number;
};

const isCursorError = (error: UiError) =>
  error.code === "validation_error" && Boolean(error.fieldErrors?.cursor);

/**
 * A customer's relationship profile: who she is, her next appointment, her
 * history (the timeline, at the centre) and what is durably known about her
 * (the dossier). Profile and first timeline page load in parallel; each
 * zone fails and retries on its own.
 */
export function ClientProfile({ clientId }: { clientId: string }) {
  const [profile, setProfile] = useState<Load<ClientProfileDto>>({
    status: "loading",
  });
  const [timeline, setTimeline] = useState<TimelineState>({
    status: "loading",
    events: [],
    nextCursor: null,
    error: null,
    more: "idle",
    pages: 0,
  });
  const [profileRun, setProfileRun] = useState(0);
  const [timelineRun, setTimelineRun] = useState(0);
  const [tab, setTab] = useState<"history" | "dossier">("history");
  const backHref = useSyncExternalStore(
    noSubscription,
    savedDirectory,
    () => DIRECTORY,
  );
  // One layout at a time (never the history twice in the page).
  const wide = useMediaQuery("(min-width: 1024px)");
  const alive = useRef(true);
  const timelineToken = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    void callAction(() => getClientProfileAction({ clientId })).then(
      (result) => {
        if (!alive.current) return;
        setProfile(
          result.ok
            ? { status: "ready", data: result.data }
            : { status: "error", error: result.error },
        );
      },
    );
  }, [clientId, profileRun]);

  useEffect(() => {
    const token = (timelineToken.current += 1);
    void callAction(() =>
      listClientTimelineAction({ clientId, limit: TIMELINE_PAGE }),
    ).then((result) => {
      if (!alive.current || token !== timelineToken.current) return;
      setTimeline(
        result.ok
          ? {
              status: "ready",
              events: result.data.events,
              nextCursor: result.data.nextCursor,
              error: null,
              more: "idle",
              pages: 1,
            }
          : {
              status: "error",
              events: [],
              nextCursor: null,
              error: result.error,
              more: "idle",
              pages: 0,
            },
      );
    });
  }, [clientId, timelineRun]);

  async function loadOlder() {
    if (timeline.status !== "ready" || !timeline.nextCursor) return;
    if (timeline.more === "loading") return;
    const token = timelineToken.current;
    const cursor = timeline.nextCursor;
    setTimeline((value) => ({ ...value, more: "loading" }));
    const result = await callAction(() =>
      listClientTimelineAction({ clientId, limit: TIMELINE_PAGE, cursor }),
    );
    if (!alive.current || token !== timelineToken.current) return;
    if (!result.ok) {
      if (isCursorError(result.error)) {
        // The cursor no longer fits: a fresh history from the top.
        setTimelineRun((value) => value + 1);
        return;
      }
      setTimeline((value) => ({ ...value, more: result.error }));
      return;
    }
    // Existing events are never replaced; a page can only add to them.
    setTimeline((value) => ({
      ...value,
      events: appendUnique(value.events, result.data.events),
      nextCursor: result.data.nextCursor,
      more: "idle",
      pages: value.pages + 1,
    }));
  }

  if (profile.status === "error") {
    if (profile.error.code === "client_not_found") {
      return (
        <Page backHref={backHref}>
          <div className="flex flex-col items-start gap-3 rounded-3xl border border-line bg-paper-raised px-5 py-7">
            <h1 className="font-display text-[28px] leading-tight text-ink">
              Cette fiche n’existe pas ou plus
            </h1>
            <p className="text-[14.5px] text-ink-soft">
              Elle a pu être fusionnée avec une autre fiche, ou le lien est
              incorrect.
            </p>
            <Link
              href={backHref as "/app/clients"}
              className="text-[14.5px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
            >
              Retour aux clientes
            </Link>
          </div>
        </Page>
      );
    }
    return (
      <Page backHref={backHref}>
        <CrmError
          error={profile.error}
          onRetry={() => {
            setProfile({ status: "loading" });
            setProfileRun((value) => value + 1);
          }}
        >
          {profile.error.code === "unauthenticated"
            ? undefined
            : "La fiche n’a pas pu être chargée."}
        </CrmError>
      </Page>
    );
  }

  if (profile.status === "loading") {
    return (
      <Page backHref={backHref}>
        <ProfileSkeleton />
      </Page>
    );
  }

  const data = profile.data;
  const history = (
    <Timeline
      state={timeline}
      client={data.client}
      timezone={data.timezone}
      onLoadOlder={() => void loadOlder()}
      onRetry={() => {
        setTimeline({
          status: "loading",
          events: [],
          nextCursor: null,
          error: null,
          more: "idle",
          pages: 0,
        });
        setTimelineRun((value) => value + 1);
      }}
    />
  );
  const dossier = <Dossier profile={data} />;

  return (
    <Page backHref={backHref}>
      <RelationshipHeader profile={data} />
      <NextAppointment profile={data} />

      {wide ? (
        // Desktop: the history at the centre, the dossier alongside.
        <div className="grid grid-cols-[minmax(0,1.7fr)_minmax(18rem,1fr)] items-start gap-6">
          {history}
          <div className="sticky top-6 flex flex-col gap-4">{dossier}</div>
        </div>
      ) : (
        // Phones and tablets: the history first, the dossier one tap away.
        <div className="flex flex-col gap-4">
          <Tabs value={tab} onChange={setTab} />
          <div
            role="tabpanel"
            id={`client-tab-${tab}`}
            aria-labelledby={`client-tab-${tab}-label`}
          >
            {tab === "history" ? history : dossier}
          </div>
        </div>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------------

function Page({
  backHref,
  children,
}: {
  backHref: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pt-3 pb-16 sm:px-6 lg:px-8 lg:pt-8">
        <Link
          href={backHref as "/app/clients"}
          className="-ml-1 flex w-fit items-center gap-1 rounded-lg px-1 py-1 text-[14px] text-ink-soft hover:text-ink"
        >
          <ChevronLeftIcon size={16} /> Clientes
        </Link>
        {children}
      </div>
    </div>
  );
}

function RelationshipHeader({ profile }: { profile: ClientProfileDto }) {
  const { client, overview } = profile;
  const year = profile.asOf.slice(0, 4);
  const since = overview.firstCompletedVisitAt
    ? `Première visite en ${monthAndYear(overview.firstCompletedVisitAt)}`
    : `Fiche créée le ${dayMonthYear(client.createdAt)}`;
  const favorite = overview.favoriteService;
  const favoriteName = favorite?.currentName ?? "Prestation supprimée";
  const visits =
    overview.completedCount === 0
      ? "Pas encore venue"
      : `${overview.completedCount} visite${overview.completedCount > 1 ? "s" : ""}`;
  const last = overview.lastCompletedVisitAt
    ? dateWithYear(overview.lastCompletedVisitAt, year)
    : null;

  return (
    <header className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <Monogram
          firstName={client.firstName}
          lastName={client.lastName}
          size="lg"
        />
        <div className="min-w-0">
          <h1 className="font-display text-[34px] leading-none break-words text-ink sm:text-[42px]">
            {client.displayName}
          </h1>
          <p className="mt-1.5 text-[14.5px] text-ink-muted">{since}</p>
        </div>
      </div>

      {/* Phones: one compact line, so the history comes quickly. */}
      <p className="text-[14.5px] text-ink-soft md:hidden">
        {[
          visits,
          last ? `dernière le ${last}` : null,
          favorite ? `favorite : ${favoriteName}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      <dl className="hidden grid-cols-4 overflow-hidden rounded-3xl border border-line bg-paper-raised md:grid">
        <Fact label="Visites terminées">
          {overview.completedCount === 0 ? (
            <span className="text-ink-muted">Aucune</span>
          ) : (
            overview.completedCount
          )}
        </Fact>
        <Fact label="Dernière visite">
          {last ?? <span className="text-ink-muted">Pas encore venue</span>}
        </Fact>
        <Fact
          label="Prestation favorite"
          detail={
            favorite
              ? `${favorite.completedCount} fois${favorite.active === false ? " · plus proposée" : ""}`
              : undefined
          }
          small
        >
          {favorite ? (
            favoriteName
          ) : (
            <span className="text-ink-muted">Pas encore</span>
          )}
        </Fact>
        <Fact label="À venir">
          {overview.upcomingCount === 0 ? (
            <span className="text-ink-muted">Aucun</span>
          ) : (
            overview.upcomingCount
          )}
        </Fact>
      </dl>
    </header>
  );
}

function Fact({
  label,
  detail,
  small = false,
  children,
}: {
  label: string;
  detail?: string;
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-r border-line px-5 py-4 last:border-r-0">
      <dt className="text-[11.5px] font-semibold tracking-[0.08em] text-ink-muted uppercase">
        {label}
      </dt>
      <dd
        className={cn(
          "font-display leading-tight break-words text-ink tabular-nums",
          small ? "text-[21px]" : "text-[28px]",
        )}
      >
        {children}
      </dd>
      {detail ? <dd className="text-[13px] text-ink-muted">{detail}</dd> : null}
    </div>
  );
}

function NextAppointment({ profile }: { profile: ClientProfileDto }) {
  const next = profile.nextAppointment;
  const pending = profile.overview.pastConfirmedCount;
  return (
    <>
      {next ? (
        <section
          aria-label="Prochain rendez-vous"
          className="flex flex-col gap-3 rounded-3xl border border-accent/20 bg-accent-soft px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
        >
          <div className="flex items-center gap-4">
            <DateBox appointment={next} />
            <div className="min-w-0">
              <p className="text-[15.5px] font-semibold text-ink">
                Prochain rendez-vous · {timeLabel(next.startsAt)} –{" "}
                {timeLabel(next.endsAt)}
              </p>
              <p className="text-[14px] text-ink-soft">
                {next.service.name} ·{" "}
                {formatPrice(next.price.amountCents, next.price.currency)}{" "}
                prévus
              </p>
              {profile.overview.upcomingCount > 1 ? (
                <p className="text-[13px] text-ink-muted">
                  et {profile.overview.upcomingCount - 1} autre
                  {profile.overview.upcomingCount > 2 ? "s" : ""} à venir
                </p>
              ) : null}
            </div>
          </div>
          <Link
            href={agendaDayHref(next.startsAt)}
            className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-line bg-paper-raised px-4 text-[14.5px] font-medium text-ink hover:border-line-strong sm:ml-auto"
          >
            <CalendarIcon size={17} /> Voir la journée dans l’agenda
          </Link>
        </section>
      ) : null}
      {pending > 0 ? (
        <Notice
          tone="warning"
          action={
            <Link
              href="/app"
              className="text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
            >
              Indiquer dans l’agenda
            </Link>
          }
        >
          {pending === 1
            ? "Un rendez-vous passé attend son statut."
            : `${pending} rendez-vous passés attendent leur statut.`}
        </Notice>
      ) : null}
    </>
  );
}

function DateBox({ appointment }: { appointment: AppointmentSummaryDto }) {
  const date = appointment.startsAt.local.slice(0, 10);
  return (
    <span
      aria-hidden="true"
      className="flex w-14 shrink-0 flex-col items-center rounded-2xl bg-paper-raised py-1.5 leading-tight"
    >
      <span className="text-[11px] font-semibold tracking-[0.06em] text-accent uppercase">
        {weekdayShort(appointment.startsAt)}
      </span>
      <span className="font-display text-[26px] text-ink">
        {Number(date.slice(8, 10))}
      </span>
      <span className="text-[11px] text-ink-muted">
        {monthShort(appointment.startsAt)}
      </span>
    </span>
  );
}

function Tabs({
  value,
  onChange,
}: {
  value: "history" | "dossier";
  onChange: (value: "history" | "dossier") => void;
}) {
  const options = [
    { value: "history", label: "Historique" },
    { value: "dossier", label: "Dossier" },
  ] as const;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div
      role="tablist"
      aria-label="Fiche cliente"
      className="sticky top-0 z-10 grid grid-cols-2 rounded-2xl bg-sand p-1"
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`client-tab-${option.value}-label`}
            aria-selected={selected}
            aria-controls={`client-tab-${option.value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft")
                return;
              event.preventDefault();
              const next = options[(index + 1) % options.length]!;
              onChange(next.value);
              refs.current[(index + 1) % options.length]?.focus();
            }}
            className={cn(
              "h-10 cursor-pointer rounded-xl text-[14.5px] transition-colors",
              selected
                ? "bg-paper-raised font-semibold text-ink shadow-[0_1px_3px_rgba(35,28,24,0.12)]"
                : "text-ink-soft hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dossier: what is durably known, only from the CRM read model.
// ---------------------------------------------------------------------------

function Dossier({ profile }: { profile: ClientProfileDto }) {
  const { client, overview, upcoming } = profile;
  const others = overview.upcomingCount - upcoming.length;
  const observed = [
    overview.firstCompletedVisitAt
      ? ["Première visite", longDate(overview.firstCompletedVisitAt)]
      : null,
    overview.lastCompletedVisitAt
      ? ["Dernière visite", longDate(overview.lastCompletedVisitAt)]
      : null,
    overview.favoriteService
      ? [
          "Prestation favorite",
          `${overview.favoriteService.currentName ?? "Prestation supprimée"} · ${overview.favoriteService.completedCount} fois${overview.favoriteService.active === false ? " · plus proposée" : ""}`,
        ]
      : null,
    overview.cancelledCount > 0
      ? ["Annulations", String(overview.cancelledCount)]
      : null,
    overview.noShowCount > 0
      ? ["Absences", String(overview.noShowCount)]
      : null,
  ].filter((entry): entry is [string, string] => entry !== null);

  return (
    <div className="flex flex-col gap-4">
      <DossierSection title="Coordonnées">
        <ContactLine
          icon={<MailIcon size={17} />}
          label="Email"
          value={client.email}
        />
        <ContactLine
          icon={<PhoneIcon size={17} />}
          label="Téléphone"
          value={client.phone}
        />
        <p className="text-[13px] text-ink-muted">
          Fiche créée le {dayMonthYear(client.createdAt)}
        </p>
      </DossierSection>

      <DossierSection title="À venir">
        {upcoming.length === 0 ? (
          <p className="text-[14px] text-ink-muted">
            Aucun rendez-vous à venir.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {upcoming.map((appointment) => (
              <li key={appointment.id} className="flex flex-col gap-0.5">
                <span className="text-[14.5px] font-medium text-ink">
                  {dayAndTime(appointment.startsAt)}
                </span>
                <span className="text-[13.5px] text-ink-soft">
                  {appointment.service.name}
                </span>
                <Link
                  href={agendaDayHref(appointment.startsAt)}
                  className="w-fit text-[13px] text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink"
                >
                  Voir la journée dans l’agenda
                </Link>
              </li>
            ))}
            {others > 0 ? (
              <li className="text-[13.5px] text-ink-muted">
                et {others} autre{others > 1 ? "s" : ""} plus tard
              </li>
            ) : null}
          </ul>
        )}
      </DossierSection>

      <DossierSection title="Habitudes observées">
        {observed.length === 0 ? (
          <p className="text-[14px] text-ink-muted">
            Rien à observer pour l’instant : aucune visite terminée.
          </p>
        ) : (
          <dl className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-[14px]">
            {observed.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-ink-muted">{label}</dt>
                <dd className="min-w-0 break-words text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </DossierSection>

      {overview.completedServiceValue.length > 0 ? (
        <DossierSection title="Valeur des prestations réalisées">
          <ul className="flex flex-col gap-2">
            {overview.completedServiceValue.map((value) => (
              <li key={value.currency} className="flex flex-col">
                <span className="font-display text-[26px] leading-tight text-ink tabular-nums">
                  {formatPrice(value.amountCents, value.currency)}
                </span>
                <span className="text-[13px] text-ink-muted">
                  {value.appointmentCount} rendez-vous terminé
                  {value.appointmentCount > 1 ? "s" : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-ink-muted">
            Somme des prix enregistrés sur les rendez-vous terminés. Ce n’est
            pas un encaissement.
          </p>
        </DossierSection>
      ) : null}

      <p className="px-1 text-[12.5px] text-ink-muted">
        Heures affichées dans le fuseau {profile.timezone}.
      </p>
    </div>
  );
}

function DossierSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised px-5 py-5"
    >
      <h2 id={id} className="font-display text-[22px] leading-tight text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ContactLine({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const valueRef = useRef<HTMLSpanElement>(null);

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused: select the text so it can be copied by hand.
      const range = document.createRange();
      if (valueRef.current) range.selectNodeContents(valueRef.current);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-sand text-ink-soft">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[12px] text-ink-muted">{label}</span>
        {value ? (
          <span
            ref={valueRef}
            className="text-[14.5px] break-all text-ink select-all"
          >
            {value}
          </span>
        ) : (
          <span className="text-[14.5px] text-ink-muted">Non renseigné</span>
        )}
      </div>
      {value ? (
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copier ${label === "Email" ? "l’email" : "le téléphone"}`}
          className="flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl px-3 text-[13.5px] text-ink-soft hover:bg-sand hover:text-ink"
        >
          <CopyIcon size={16} />
          <span aria-live="polite">{copied ? "Copié" : "Copier"}</span>
        </button>
      ) : null}
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true">
      <span className="sr-only" role="status">
        Chargement de la fiche…
      </span>
      <div className="flex items-center gap-4">
        <span className="size-14 animate-pulse rounded-full bg-sand" />
        <span className="flex flex-col gap-2">
          <span className="h-8 w-56 animate-pulse rounded-xl bg-sand" />
          <span className="h-3.5 w-40 animate-pulse rounded-full bg-sand/70" />
        </span>
      </div>
      <span className="h-20 animate-pulse rounded-3xl bg-sand/70" />
      <span className="h-64 animate-pulse rounded-3xl bg-sand/50" />
    </div>
  );
}

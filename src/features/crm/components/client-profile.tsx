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
  ClientNoteDto,
  ClientProfileDto,
  ClientTimelineEvent,
  UpdateClientResultDto,
} from "@/features/crm/types";
import {
  ClientLoyalty,
  type LoyaltyVisit,
} from "@/features/loyalty/components/client-loyalty";
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
import { EditClientSheet } from "./edit-client";
import { Monogram } from "./monogram";
import {
  DeleteNoteDialog,
  DossierNotes,
  NoteComposerSheet,
  NoteEditorSheet,
  useNotesList,
  type NoteChange,
  type NotesListState,
} from "./notes";
import { Timeline, type NoteHandlers } from "./timeline";

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
  /** The latest read of the first page: in progress, done or failed. */
  status: "loading" | "ready" | "error";
  /**
   * One coherent sequence: a first page and the older pages read after it,
   * all in the same time zone. Kept while it is re-read or if that fails.
   */
  events: ClientTimelineEvent[];
  /** Time zone of `events`, as returned with them (null before any). */
  timezone: string | null;
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
 *
 * The professional edits the record and writes private notes from here.
 * Drafts live in this page, apart from the data read: a refresh, a failed
 * write or a closed sheet never erase them. After every confirmed note
 * write, the history and the dossier's notes are read again (the server's
 * order and content decide). The route mounts one instance per customer.
 */
export function ClientProfile({
  clientId,
  scope,
}: {
  clientId: string;
  /** The signed-in identity, from the server session (pending loyalty writes). */
  scope: { userId: string; businessId: string };
}) {
  const [profile, setProfile] = useState<Load<ClientProfileDto>>({
    status: "loading",
  });
  const [timeline, setTimeline] = useState<TimelineState>({
    status: "loading",
    events: [],
    timezone: null,
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
  /**
   * Generation of profile reads, shared by every path (first load, retry,
   * "Recharger la fiche", automatic re-read, another customer): each new
   * read supersedes all older ones, whatever order the answers arrive in.
   */
  const profileRead = useRef(0);
  const timelineToken = useRef(0);
  /** History time zone for which the profile was last re-read (once each). */
  const realignedFor = useRef<string | null>(null);

  const notesList = useNotesList(clientId);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [editingNote, setEditingNote] = useState<ClientNoteDto | null>(null);
  const [deletingNote, setDeletingNote] = useState<ClientNoteDto | null>(null);
  const [editingClient, setEditingClient] = useState(false);
  const [clientDraft, setClientDraft] = useState(false);
  const [saved, setSaved] = useState<UpdateClientResultDto | null>(null);
  const [announcement, setAnnouncement] = useState("");
  /** Bumped when the focused control disappeared (a deleted note). */
  const [refocus, setRefocus] = useState(0);

  // After the dialog closed (its cleanup runs first, in the same commit).
  useEffect(() => {
    if (refocus === 0) return;
    const target =
      document.querySelector<HTMLElement>("[data-notes-heading]") ??
      document.getElementById("client-history");
    target?.focus();
  }, [refocus]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const read = (profileRead.current += 1);
    void callAction(() => getClientProfileAction({ clientId })).then(
      (result) => {
        if (!alive.current || read !== profileRead.current) return;
        setProfile(
          result.ok
            ? { status: "ready", data: result.data }
            : { status: "error", error: result.error },
        );
      },
    );
    // Another customer, a newer read or leaving: this answer is obsolete.
    return () => {
      profileRead.current += 1;
    };
  }, [clientId, profileRun]);

  useEffect(() => {
    const token = (timelineToken.current += 1);
    void callAction(() =>
      listClientTimelineAction({ clientId, limit: TIMELINE_PAGE }),
    ).then((result) => {
      if (!alive.current || token !== timelineToken.current) return;
      setTimeline((value) =>
        result.ok
          ? {
              status: "ready",
              events: result.data.events,
              timezone: result.data.timezone,
              nextCursor: result.data.nextCursor,
              error: null,
              more: "idle",
              pages: 1,
            }
          : // What was shown stays (in its own time zone), marked out of date.
            { ...value, status: "error", error: result.error, more: "idle" },
      );
    });
  }, [clientId, timelineRun]);

  // The business changed time zone between the two reads: re-read the
  // profile once for that zone, so both speak the same hours. Bounded: a
  // further mismatch is shown as such, never chased.
  const profileZone = profile.status === "ready" ? profile.data.timezone : null;
  useEffect(() => {
    const zone = timeline.timezone;
    if (!profileZone || !zone || profileZone === zone) return;
    if (realignedFor.current === zone) return;
    realignedFor.current = zone;
    // Same generation as every other profile read. No cleanup here: a
    // change of these inputs must not cancel a newer read in flight.
    const read = (profileRead.current += 1);
    void callAction(() => getClientProfileAction({ clientId })).then(
      (result) => {
        if (!alive.current || read !== profileRead.current) return;
        // A failed re-read keeps the profile shown; the notice stays.
        if (result.ok) setProfile({ status: "ready", data: result.data });
      },
    );
  }, [clientId, profileZone, timeline.timezone]);

  /** A fresh history from the first page; what is shown stays meanwhile. */
  function reloadTimeline() {
    setTimeline((value) => ({
      ...value,
      status: "loading",
      error: null,
      more: "idle",
    }));
    setTimelineRun((value) => value + 1);
  }

  /** A confirmed note write: shown at once, then both views re-read. */
  function notesChanged(change: NoteChange) {
    if (change.type === "updated") {
      // Same id, same position (its date never changes).
      setTimeline((value) => ({
        ...value,
        events: value.events.map((event) =>
          event.kind === "note" && event.note.id === change.note.id
            ? { ...event, note: change.note }
            : event,
        ),
      }));
    } else if (change.type === "deleted") {
      setTimeline((value) => ({
        ...value,
        events: value.events.filter(
          (event) =>
            !(event.kind === "note" && event.note.id === change.noteId),
        ),
      }));
      // Its buttons are gone: the keyboard continues on the notes.
      setRefocus((value) => value + 1);
    }
    notesList.apply(change);
    reloadTimeline();
    notesList.reload();
    setAnnouncement(
      change.type === "created"
        ? "Note ajoutée à l’historique."
        : change.type === "updated"
          ? "Note modifiée."
          : change.type === "deleted"
            ? "Note supprimée."
            : "",
    );
  }

  function clientSaved(result: UpdateClientResultDto) {
    const { client } = result;
    setSaved(result);
    setProfile((value) =>
      value.status === "ready"
        ? {
            ...value,
            data: {
              ...value.data,
              client: {
                ...value.data.client,
                displayName: client.displayName,
                firstName: client.firstName,
                lastName: client.lastName,
                email: client.email,
                phone: client.phone,
              },
            },
          }
        : value,
    );
    // A newer read supersedes any older one still in flight.
    setProfileRun((value) => value + 1);
    setAnnouncement(
      result.changed ? "Fiche mise à jour." : "Aucune modification.",
    );
  }

  function showHistory() {
    if (!wide) setTab("history");
    window.setTimeout(() => {
      const heading = document.getElementById("client-history");
      heading?.scrollIntoView?.({ block: "start" });
      heading?.focus();
    }, 0);
  }

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
        reloadTimeline();
        return;
      }
      setTimeline((value) => ({ ...value, more: result.error }));
      return;
    }
    if (result.data.timezone !== timeline.timezone) {
      // Hours of another time zone: never mixed with what is shown. The
      // sequence starts again from the first page (on this request only).
      reloadTimeline();
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
  const noteHandlers: NoteHandlers = {
    onAdd: () => setComposerOpen(true),
    onEdit: setEditingNote,
    onDelete: setDeletingNote,
  };
  const history = (
    <Timeline
      state={timeline}
      client={data.client}
      notes={noteHandlers}
      onLoadOlder={() => void loadOlder()}
      onRetry={reloadTimeline}
    />
  );
  const loyalty = (
    <ClientLoyalty
      // One card per signed-in user, business and customer: nothing open,
      // typed or read under one identity is kept for another.
      key={`${scope.userId}:${scope.businessId}:${clientId}`}
      timezone={data.timezone}
      visits={loyaltyVisits(data, timeline.events)}
      scope={{ ...scope, clientId }}
      onChanged={reloadTimeline}
    />
  );
  const dossier = (
    <Dossier
      profile={data}
      loyalty={loyalty}
      notes={notesList.state}
      noteHandlers={noteHandlers}
      onNotesRetry={notesList.reload}
      onShowHistory={showHistory}
      onEditClient={() => setEditingClient(true)}
      clientDraft={clientDraft}
      saved={saved}
    />
  );

  return (
    <Page backHref={backHref}>
      <RelationshipHeader profile={data} />
      <NextAppointment profile={data} />
      {timeline.timezone && timeline.timezone !== data.timezone ? (
        <Notice
          tone="info"
          action={
            <button
              type="button"
              onClick={() => {
                realignedFor.current = null;
                setProfileRun((value) => value + 1);
                reloadTimeline();
              }}
              className="cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
            >
              Recharger la fiche
            </button>
          }
        >
          Le fuseau horaire du commerce a changé : la fiche est en heures de{" "}
          {data.timezone}, l’historique en heures de {timeline.timezone}.
        </Notice>
      ) : null}

      {wide ? (
        // Desktop: the history at the centre, the dossier alongside.
        <div className="grid grid-cols-[minmax(0,1.7fr)_minmax(18rem,1fr)] items-start gap-6">
          {history}
          <div className="flex min-w-0 flex-col gap-4">{dossier}</div>
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

      <p className="sr-only" role="status">
        {announcement}
      </p>
      <NoteComposerSheet
        clientId={clientId}
        open={composerOpen}
        text={composerText}
        onTextChange={setComposerText}
        onClose={() => setComposerOpen(false)}
        onChanged={notesChanged}
      />
      <NoteEditorSheet
        clientId={clientId}
        note={editingNote}
        onClose={() => setEditingNote(null)}
        onChanged={notesChanged}
        onSaveAsNew={(text) => {
          setEditingNote(null);
          setComposerText(text);
          setComposerOpen(true);
        }}
      />
      <DeleteNoteDialog
        clientId={clientId}
        note={deletingNote}
        onClose={() => setDeletingNote(null)}
        onChanged={notesChanged}
      />
      <EditClientSheet
        clientId={clientId}
        open={editingClient}
        onClose={() => setEditingClient(false)}
        onSaved={clientSaved}
        onDraftChange={setClientDraft}
      />
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
          <h1 className="font-display text-[34px] leading-none wrap-anywhere text-ink sm:text-[42px]">
            {client.displayName}
          </h1>
          <p className="mt-1.5 text-[14.5px] text-ink-muted">{since}</p>
        </div>
      </div>

      {/* Phones: one compact line, so the history comes quickly. */}
      <p className="text-[14.5px] wrap-anywhere text-ink-soft md:hidden">
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
          "font-display leading-tight wrap-anywhere text-ink tabular-nums",
          small ? "text-[21px]" : "text-[28px]",
        )}
      >
        {children}
      </dd>
      {detail ? (
        <dd className="text-[13px] wrap-anywhere text-ink-muted">{detail}</dd>
      ) : null}
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
          <div className="flex min-w-0 items-center gap-4 sm:flex-1">
            <DateBox appointment={next} />
            <div className="min-w-0">
              <p className="text-[15.5px] font-semibold text-ink">
                Prochain rendez-vous · {timeLabel(next.startsAt)} –{" "}
                {timeLabel(next.endsAt)}
              </p>
              <p className="text-[14px] wrap-anywhere text-ink-soft">
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

function Dossier({
  profile,
  loyalty,
  notes,
  noteHandlers,
  onNotesRetry,
  onShowHistory,
  onEditClient,
  clientDraft,
  saved,
}: {
  profile: ClientProfileDto;
  /** The customer's loyalty (its own reads and writes). */
  loyalty: ReactNode;
  notes: NotesListState;
  noteHandlers: NoteHandlers;
  onNotesRetry: () => void;
  onShowHistory: () => void;
  onEditClient: () => void;
  /** Unsaved changes are kept in the edit form. */
  clientDraft: boolean;
  /** The last confirmed save, for its message. */
  saved: UpdateClientResultDto | null;
}) {
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
      <DossierSection
        title="Coordonnées"
        action={
          <button
            type="button"
            onClick={onEditClient}
            aria-label={
              clientDraft
                ? "Reprendre la modification de la fiche"
                : "Modifier la fiche"
            }
            className="flex h-10 shrink-0 cursor-pointer items-center rounded-xl border border-line px-3 text-[13.5px] font-medium text-ink hover:border-line-strong"
          >
            {clientDraft ? "Reprendre la modification" : "Modifier"}
          </button>
        }
      >
        {clientDraft ? (
          <p className="text-[13px] text-ink-muted">
            Modifications non enregistrées, conservées pour plus tard.
          </p>
        ) : null}
        {saved ? <SavedMessage result={saved} /> : null}
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

      {loyalty}

      <DossierNotes
        list={notes}
        profileTimezone={profile.timezone}
        onAdd={noteHandlers.onAdd}
        onEdit={noteHandlers.onEdit}
        onDelete={noteHandlers.onDelete}
        onRetry={onNotesRetry}
        onShowHistory={onShowHistory}
      />

      <DossierSection title="À venir">
        {upcoming.length === 0 ? (
          <p className="text-[14px] text-ink-muted">
            Aucun rendez-vous à venir.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {upcoming.map((appointment) => (
              <li
                key={appointment.id}
                className="flex min-w-0 flex-col gap-0.5"
              >
                <span className="text-[14.5px] font-medium text-ink">
                  {dayAndTime(appointment.startsAt)}
                </span>
                <span className="text-[13.5px] wrap-anywhere text-ink-soft">
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
                <dd className="min-w-0 wrap-anywhere text-ink">{value}</dd>
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
                <span className="font-display text-[26px] leading-tight wrap-anywhere text-ink tabular-nums">
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

/**
 * Visits a reward can be attached to when it is used: her upcoming and
 * shown past appointments that took or will take place (not cancelled or
 * missed), newest first, as already read for this file.
 */
function loyaltyVisits(
  profile: ClientProfileDto,
  events: ClientTimelineEvent[],
): LoyaltyVisit[] {
  const seen = new Set<string>();
  const visits: LoyaltyVisit[] = [];
  const add = (appointment: AppointmentSummaryDto) => {
    if (seen.has(appointment.id)) return;
    if (
      appointment.status !== "completed" &&
      appointment.status !== "confirmed"
    )
      return;
    seen.add(appointment.id);
    visits.push({
      id: appointment.id,
      label: `${dayAndTime(appointment.startsAt)} · ${appointment.service.name}`,
    });
  };
  [...profile.upcoming].reverse().forEach(add);
  for (const event of events)
    if (event.kind === "appointment") add(event.appointment);
  return visits;
}

function DossierSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised px-5 py-5"
    >
      {/* Wraps when the action is long (a kept draft) on narrow phones. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id={id} className="font-display text-[22px] leading-tight text-ink">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** What a confirmed save changed, and what keeps its former contact. */
function SavedMessage({ result }: { result: UpdateClientResultDto }) {
  const {
    upcomingAppointmentsWithOtherEmail: upcoming,
    queuedEmailsToOtherAddress: queued,
  } = result.retained;
  const kept = [
    upcoming > 0
      ? `${upcoming} rendez-vous à venir ${upcoming > 1 ? "gardent" : "garde"} l’email indiqué à la réservation`
      : null,
    queued > 0
      ? `${queued} email${queued > 1 ? "s" : ""} déjà programmé${queued > 1 ? "s" : ""} ${queued > 1 ? "restent adressés" : "reste adressé"} à l’ancienne adresse`
      : null,
  ].filter(Boolean);
  return (
    <Notice tone="success">
      {result.changed
        ? "Fiche mise à jour."
        : "Aucune modification : la fiche avait déjà ces informations."}
      {kept.length > 0 ? ` ${kept.join(" ; ")}.` : null}
    </Notice>
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

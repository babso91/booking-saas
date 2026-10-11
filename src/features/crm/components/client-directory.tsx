"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ChevronRightIcon, CloseIcon, SearchIcon } from "@/components/ui/icons";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { listClientsAction } from "@/features/crm/actions/crm";
import {
  CLIENT_FILTERS,
  CLIENT_SORTS,
  type ClientFilter,
  type ClientSort,
  type DirectoryClientDto,
} from "@/features/crm/types";
import { bookingHost } from "@/lib/brand";
import { cn } from "@/lib/cn";

import { filterLabels, sortLabels } from "../client/copy";
import {
  appendUnique,
  DEFAULT_QUERY,
  directoryHref,
  type DirectoryQuery,
} from "../client/directory-state";
import { dateWithYear, dayAndTime } from "../client/format";
import { CrmError } from "./crm-error";
import { Monogram } from "./monogram";

const PAGE_SIZE = 25;
/** Pause after typing before searching. */
const SEARCH_DELAY_MS = 250;

type Listing = {
  /** The read these rows belong to (query, filter, sort). */
  key: string;
  clients: DirectoryClientDto[];
  totalCount: number;
  nextCursor: string | null;
  /** Year of the reference instant: other years are written out. */
  year: string;
};

const keyOf = (state: DirectoryQuery) =>
  JSON.stringify([state.query.trim(), state.filter, state.sort]);

const isCursorError = (error: UiError) =>
  error.code === "validation_error" && Boolean(error.fieldErrors?.cursor);

/**
 * What is asked for, and which read: `seq` changes with every new first
 * page (new criteria, retry, restart after a refused cursor), so an answer
 * is only ever attributed to the read that produced it.
 */
type Request = { state: DirectoryQuery; seq: number };

/**
 * Customer directory: search, filter, sort and pages of 25 from the CRM
 * read model. What is shown lives in the address. Live pagination: the
 * count is the current one, a row seen twice is shown once, and a refused
 * cursor restarts from the first page.
 *
 * Rows are only ever shown for the criteria on screen. While they are
 * re-read they say so; if that read fails they stay, marked as possibly
 * out of date, with a retry. Rows of other criteria are never shown.
 */
export function ClientDirectory({
  initial,
  slug,
}: {
  initial: DirectoryQuery;
  slug: string;
}) {
  const [text, setText] = useState(initial.query);
  const [request, setRequest] = useState<Request>({ state: initial, seq: 0 });
  /** Last rows read successfully (for `listing.key`). */
  const [listing, setListing] = useState<Listing | null>(null);
  /** How the last answered first-page read ended. */
  const [outcome, setOutcome] = useState<{
    seq: number;
    error: UiError | null;
  } | null>(null);
  const [more, setMore] = useState<"idle" | "loading" | UiError>("idle");
  const latest = useRef(0);
  const firstNew = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const state = request.state;
  const key = keyOf(state);
  const change = (patch: Partial<DirectoryQuery>) =>
    setRequest((value) => ({
      state: { ...value.state, ...patch },
      seq: value.seq + 1,
    }));
  const reload = () =>
    setRequest((value) => ({ state: value.state, seq: value.seq + 1 }));

  // Typing: search after a short pause.
  useEffect(() => {
    if (text === state.query) return;
    const timer = window.setTimeout(
      () =>
        setRequest((value) => ({
          state: { ...value.state, query: text },
          seq: value.seq + 1,
        })),
      SEARCH_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [text, state.query]);

  // The address follows what is shown, and the profile's "Clientes" link
  // comes back to it (Back finds it again too).
  useEffect(() => {
    const href = directoryHref(state);
    window.history.replaceState(window.history.state, "", href);
    try {
      window.sessionStorage.setItem("crm:directory", href);
    } catch {
      // Storage unavailable: the profile links to the plain directory.
    }
  }, [state]);

  // First page of every new read; only the latest one is ever applied.
  useEffect(() => {
    const seq = request.seq;
    latest.current = seq;
    void callAction(() =>
      listClientsAction({
        query: state.query,
        filter: state.filter,
        sort: state.sort,
        limit: PAGE_SIZE,
      }),
    ).then((result) => {
      if (seq !== latest.current) return;
      setMore("idle");
      if (result.ok) {
        setListing({
          key,
          clients: result.data.clients,
          totalCount: result.data.totalCount,
          nextCursor: result.data.nextCursor,
          year: result.data.asOf.slice(0, 4),
        });
      }
      setOutcome({ seq, error: result.ok ? null : result.error });
    });
    // `request.seq` changes with every read (and its criteria).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.seq]);

  async function loadMore() {
    if (!listing?.nextCursor || more === "loading") return;
    const token = latest.current;
    if (outcome?.seq !== token || outcome.error) return;
    setMore("loading");
    const result = await callAction(() =>
      listClientsAction({
        query: state.query,
        filter: state.filter,
        sort: state.sort,
        limit: PAGE_SIZE,
        cursor: listing.nextCursor,
      }),
    );
    if (token !== latest.current) return;
    if (!result.ok) {
      if (isCursorError(result.error)) {
        // The cursor no longer fits: start again from a fresh first page
        // (once: a first page carries no cursor to refuse).
        reload();
        return;
      }
      setMore(result.error);
      return;
    }
    const added = appendUnique(listing.clients, result.data.clients).slice(
      listing.clients.length,
    );
    firstNew.current = added[0]?.id ?? null;
    setListing({
      ...listing,
      clients: [...listing.clients, ...added],
      totalCount: result.data.totalCount,
      nextCursor: result.data.nextCursor,
    });
    setMore("idle");
  }

  // After "Voir plus", the keyboard continues on the first new customer.
  useEffect(() => {
    if (!firstNew.current) return;
    listRef.current
      ?.querySelector<HTMLAnchorElement>(`[data-client="${firstNew.current}"]`)
      ?.focus();
    firstNew.current = null;
  }, [listing]);

  // Rows only for the criteria on screen; the state of their latest read.
  const current = listing?.key === key ? listing : null;
  const settled = outcome?.seq === request.seq;
  const refreshing = !settled;
  const failure = settled ? outcome.error : null;
  const searching = state.query.trim() !== "";
  const narrowed = searching || state.filter !== "all";

  const clearSearch = () => {
    setText("");
    change({ query: "" });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-10">
        <header className="flex flex-col gap-1.5">
          <h1 className="font-display text-[34px] leading-none text-ink sm:text-[40px]">
            Clientes
          </h1>
          <p
            className="text-[14.5px] text-ink-muted tabular-nums"
            aria-live="polite"
          >
            {current
              ? countLabel(current.totalCount, narrowed)
              : failure
                ? null
                : "Chargement des clientes…"}
          </p>
        </header>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="relative flex min-w-0 flex-1">
            <span className="sr-only">Rechercher une cliente</span>
            <SearchIcon
              size={18}
              className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-ink-muted"
            />
            <input
              type="search"
              value={text}
              maxLength={100}
              onChange={(event) => setText(event.target.value)}
              placeholder="Nom, email ou téléphone"
              autoComplete="off"
              enterKeyHint="search"
              className="h-12 w-full rounded-2xl border border-line bg-paper-raised pr-11 pl-11 text-[16px] text-ink transition-[border-color,box-shadow] duration-200 placeholder:text-ink-muted hover:border-line-strong focus-visible:border-ink focus-visible:shadow-[0_0_0_4px_rgba(151,73,58,0.12)] focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            {text ? (
              <button
                type="button"
                onClick={clearSearch}
                aria-label="Vider le champ de recherche"
                className="absolute top-1/2 right-2 flex size-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xl text-ink-muted hover:bg-sand hover:text-ink"
              >
                <CloseIcon size={16} />
              </button>
            ) : null}
          </label>

          <label className="flex shrink-0 items-center gap-2 text-[14px] text-ink-soft">
            <span>Trier par</span>
            <select
              value={state.sort}
              onChange={(event) =>
                change({ sort: event.target.value as ClientSort })
              }
              className="h-12 cursor-pointer rounded-2xl border border-line bg-paper-raised px-3 text-[15px] text-ink hover:border-line-strong focus-visible:border-ink focus-visible:shadow-[0_0_0_4px_rgba(151,73,58,0.12)] focus-visible:outline-none"
            >
              {CLIENT_SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {sortLabels[sort]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="-mx-4 min-w-0 px-4 sm:mx-0 sm:px-0">
          <legend className="sr-only">Afficher</legend>
          <div className="flex gap-2 overflow-x-auto pb-1 sm:flex-wrap">
            {CLIENT_FILTERS.map((filter) => (
              <FilterChip
                key={filter}
                filter={filter}
                checked={state.filter === filter}
                onSelect={(value) => change({ filter: value })}
              />
            ))}
          </div>
        </fieldset>

        {current && failure ? (
          <CrmError error={failure} onRetry={reload}>
            {failure.code === "unauthenticated"
              ? undefined
              : "La liste n’a pas pu être actualisée. Les clientes affichées viennent du dernier chargement réussi et peuvent ne plus être à jour."}
          </CrmError>
        ) : current && refreshing ? (
          <p role="status" className="text-[13.5px] text-ink-muted">
            Actualisation de la liste…
          </p>
        ) : null}

        {failure && !current ? (
          <CrmError error={failure} onRetry={reload}>
            {failure.code === "unauthenticated"
              ? undefined
              : "La liste des clientes n’a pas pu être chargée."}
          </CrmError>
        ) : !current ? (
          <ListSkeleton />
        ) : current.clients.length === 0 ? (
          narrowed ? (
            <EmptyResult
              query={state.query.trim()}
              onClear={() => {
                setText("");
                change({
                  query: DEFAULT_QUERY.query,
                  filter: DEFAULT_QUERY.filter,
                });
              }}
            />
          ) : (
            <NoClientsYet slug={slug} />
          )
        ) : (
          <section
            aria-label="Liste des clientes"
            aria-busy={refreshing}
            className={cn(
              "overflow-hidden rounded-3xl border border-line bg-paper-raised transition-opacity",
              refreshing && "opacity-60",
            )}
          >
            <div
              aria-hidden="true"
              className="hidden grid-cols-[minmax(0,2.4fr)_0.9fr_1.1fr_1.5fr_1.25rem] gap-4 border-b border-line px-5 py-3 text-[11.5px] font-semibold tracking-[0.08em] text-ink-muted uppercase md:grid"
            >
              <span>Cliente</span>
              <span>Visites</span>
              <span>Dernière visite</span>
              <span>Prochain rendez-vous</span>
              <span />
            </div>
            <ul ref={listRef} className="divide-y divide-line">
              {current.clients.map((client) => (
                <li key={client.id}>
                  <ClientRow client={client} year={current.year} />
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-3 border-t border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[13.5px] text-ink-muted tabular-nums">
                {current.clients.length} sur {current.totalCount}
              </p>
              {current.nextCursor && settled && !failure ? (
                <Button
                  variant="secondary"
                  size="md"
                  state={more === "loading" ? "loading" : "idle"}
                  loadingLabel="Chargement…"
                  onClick={() => void loadMore()}
                >
                  Voir plus de clientes
                </Button>
              ) : null}
            </div>
            {typeof more === "object" && settled && !failure ? (
              <div className="px-5 pb-4">
                <CrmError error={more} onRetry={() => void loadMore()}>
                  {more.code === "unauthenticated"
                    ? undefined
                    : "La suite de la liste n’a pas pu être chargée. Les clientes déjà affichées restent visibles."}
                </CrmError>
              </div>
            ) : null}
          </section>
        )}
      </div>
    </div>
  );
}

function countLabel(total: number, narrowed: boolean) {
  const noun = total > 1 ? "clientes" : "cliente";
  if (narrowed)
    return `${total} ${noun} ${total > 1 ? "correspondent" : "correspond"}`;
  return `${total} ${noun}`;
}

function FilterChip({
  filter,
  checked,
  onSelect,
}: {
  filter: ClientFilter;
  checked: boolean;
  onSelect: (filter: ClientFilter) => void;
}) {
  return (
    <label
      className={cn(
        "relative flex h-10 shrink-0 cursor-pointer items-center rounded-full border px-4 text-[14px] whitespace-nowrap transition-colors duration-200 ease-soft select-none",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        checked
          ? "border-ink bg-ink text-paper-raised"
          : "border-line bg-paper-raised text-ink-soft hover:border-line-strong hover:text-ink",
      )}
    >
      <input
        type="radio"
        name="client-filter"
        value={filter}
        checked={checked}
        onChange={() => onSelect(filter)}
        className="sr-only"
      />
      {filterLabels[filter]}
    </label>
  );
}

function visitsLabel(count: number) {
  if (count === 0) return "Pas encore venue";
  return `${count} visite${count > 1 ? "s" : ""}`;
}

function ClientRow({
  client,
  year,
}: {
  client: DirectoryClientDto;
  year: string;
}) {
  const contact = client.email ?? client.phone;
  const last = client.lastCompletedVisitAt
    ? dateWithYear(client.lastCompletedVisitAt, year)
    : null;
  const next = client.nextAppointment
    ? dayAndTime(client.nextAppointment.startsAt)
    : null;
  const others = client.upcomingCount - 1;

  // One complete sentence for screen readers; the visual row stays terse.
  const label = [
    client.displayName,
    client.completedCount === 0
      ? "pas encore venue"
      : `${visitsLabel(client.completedCount)}, dernière le ${last}`,
    next ? `prochain rendez-vous ${next.replace(" · ", " à ")}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Link
      href={`/app/clients/${client.id}`}
      data-client={client.id}
      aria-label={label}
      className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-paper focus-visible:bg-paper focus-visible:outline-none md:grid md:grid-cols-[minmax(0,2.4fr)_0.9fr_1.1fr_1.5fr_1.25rem] md:gap-4 md:px-5"
    >
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <Monogram firstName={client.firstName} lastName={client.lastName} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[15.5px] font-semibold text-ink group-focus-visible:underline">
            {client.displayName}
          </span>
          <span className="truncate text-[13.5px] text-ink-muted md:hidden">
            {client.completedCount === 0
              ? "Pas encore venue"
              : `${visitsLabel(client.completedCount)} · dernière ${last}`}
          </span>
          <span className="hidden truncate text-[13.5px] text-ink-muted md:block">
            {contact ?? "Aucun contact"}
          </span>
          {next ? (
            <span className="mt-1 w-fit rounded-full bg-accent-soft px-2 py-0.5 text-[12px] font-medium text-accent-strong md:hidden">
              {next}
            </span>
          ) : null}
        </span>
      </span>
      <span
        className={cn(
          "hidden text-[14.5px] tabular-nums md:block",
          client.completedCount === 0 ? "text-ink-muted" : "text-ink",
        )}
      >
        {visitsLabel(client.completedCount)}
      </span>
      <span className="hidden text-[14.5px] text-ink-soft md:block">
        {last ?? "—"}
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 md:flex md:min-w-0">
        {next ? (
          <span className="truncate rounded-full bg-accent-soft px-2.5 py-1 text-[12.5px] font-medium text-accent-strong">
            {next}
          </span>
        ) : (
          <span className="hidden text-[14.5px] text-ink-muted md:inline">
            Aucun
          </span>
        )}
        {next && others > 0 ? (
          <span className="hidden text-[12.5px] text-ink-muted lg:inline">
            +{others}
          </span>
        ) : null}
      </span>
      <ChevronRightIcon size={18} className="shrink-0 text-ink-muted" />
    </Link>
  );
}

function ListSkeleton() {
  return (
    <div
      className="overflow-hidden rounded-3xl border border-line bg-paper-raised"
      aria-busy="true"
    >
      <span className="sr-only" role="status">
        Chargement des clientes…
      </span>
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-line px-5 py-3.5 last:border-b-0"
        >
          <span className="size-10 shrink-0 animate-pulse rounded-full bg-sand" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="h-3.5 w-40 animate-pulse rounded-full bg-sand" />
            <span className="h-3 w-28 animate-pulse rounded-full bg-sand/70" />
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyResult({
  query,
  onClear,
}: {
  query: string;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-3xl border border-line bg-paper-raised px-5 py-6">
      <p className="max-w-full font-display text-[24px] leading-tight wrap-anywhere text-ink">
        {query
          ? `Aucune cliente ne correspond à « ${query} »`
          : "Aucune cliente dans cette sélection"}
      </p>
      <p className="text-[14.5px] text-ink-soft">
        La recherche porte sur le nom, l’email et le téléphone. Les accents
        comptent.
      </p>
      <Button variant="secondary" size="md" onClick={onClear}>
        {query ? "Effacer la recherche" : "Voir toutes les clientes"}
      </Button>
    </div>
  );
}

function NoClientsYet({ slug }: { slug: string }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-3xl border border-line bg-paper-raised px-5 py-7">
      <p className="font-display text-[26px] leading-tight text-ink">
        Tes clientes apparaîtront ici
      </p>
      <p className="max-w-prose text-[14.5px] text-ink-soft">
        Chaque réservation en ligne ou chaque rendez-vous ajouté dans l’agenda
        crée ou complète la fiche de la cliente.
      </p>
      <div className="flex flex-wrap items-center gap-4 pt-1">
        <Link
          href="/app"
          className="text-[14.5px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
        >
          Ouvrir l’agenda
        </Link>
        <a
          href={`/b/${slug}`}
          target="_blank"
          rel="noreferrer"
          className="text-[14.5px] text-ink-soft underline decoration-line-strong underline-offset-4"
        >
          {bookingHost()}/b/{slug}
          <span className="sr-only"> (ta page de réservation)</span>
        </a>
      </div>
    </div>
  );
}

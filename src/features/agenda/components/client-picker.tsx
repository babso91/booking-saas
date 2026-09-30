"use client";

import { useEffect, useId, useState } from "react";

import { TextField } from "@/components/ui/field";
import { SearchIcon } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import { searchAgendaClientsAction } from "@/features/agenda/actions/agenda";
import type { AgendaClientDto } from "@/features/agenda/data/lookups";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { cn } from "@/lib/cn";

const DEBOUNCE_MS = 300;
const MIN_QUERY = 2;

export type PickedClient = Pick<AgendaClientDto, "id" | "displayName"> &
  Partial<Pick<AgendaClientDto, "email" | "phone">>;

type Failure = { term: string; error: UiError };

/**
 * Search among this business's clients (tenant-scoped on the server). One
 * request per pause in typing, never per keystroke; answers for an older
 * query are ignored. Only successful answers are cached: a failed search
 * can be retried with the very same term (button, or typing again).
 */
export function ClientPicker({
  selected,
  onSelect,
  error,
  disabled,
}: {
  selected: PickedClient | null;
  onSelect: (client: PickedClient | null) => void;
  error?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Record<string, AgendaClientDto[]>>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const listId = useId();
  const term = query.trim();
  const searchable = term.length >= MIN_QUERY;
  const found = searchable ? results[term] : undefined;
  const failed = searchable && failure?.term === term ? failure.error : null;

  useEffect(() => {
    if (!searchable || term in results || failed) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      const result = await callAction(() =>
        searchAgendaClientsAction({ query: term }),
      );
      if (!active) return;
      if (result.ok)
        setResults((previous) => ({ ...previous, [term]: result.data }));
      else setFailure({ term, error: result.error });
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [term, searchable, results, failed]);

  if (selected) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-paper-raised p-3 pl-4">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] font-semibold text-ink">
            {selected.displayName}
          </span>
          {selected.email || selected.phone ? (
            <span className="truncate text-[13px] text-ink-muted">
              {[selected.email, selected.phone].filter(Boolean).join(" · ")}
            </span>
          ) : null}
        </div>
        {!disabled ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="h-10 shrink-0 cursor-pointer rounded-xl px-3 text-[14px] font-medium text-ink-soft hover:bg-sand hover:text-ink"
          >
            Changer
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <TextField
        label="Rechercher une cliente"
        type="search"
        autoComplete="off"
        enterKeyHint="search"
        placeholder="Nom, email ou téléphone"
        leadingIcon={<SearchIcon size={18} />}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setFailure(null); // typing again retries, even the same term
        }}
        error={error}
        disabled={disabled}
        aria-controls={listId}
        hint={
          term.length > 0 && !searchable ? "Au moins 2 caractères." : undefined
        }
      />
      <div id={listId} aria-live="polite">
        {searchable && !found && !failed ? (
          <p className="flex items-center gap-2 px-1 text-[13.5px] text-ink-muted">
            <Spinner size={14} /> Recherche…
          </p>
        ) : null}
        {failed ? (
          <p className="flex flex-wrap items-center gap-x-2 px-1 text-[13.5px] text-danger">
            {failed.code === "unauthenticated"
              ? "Session expirée : reconnecte-toi pour chercher."
              : "La recherche n’a pas abouti."}
            <button
              type="button"
              onClick={() => setFailure(null)}
              className="cursor-pointer font-semibold text-ink underline decoration-line-strong underline-offset-4"
            >
              Réessayer
            </button>
          </p>
        ) : null}
        {found ? (
          found.length === 0 ? (
            <p className="px-1 text-[13.5px] text-ink-muted">
              Aucune cliente trouvée. Crée une nouvelle fiche.
            </p>
          ) : (
            <ul
              className="flex flex-col gap-1.5"
              aria-label="Clientes trouvées"
            >
              {found.map((client) => (
                <li key={client.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(client)}
                    className={cn(
                      "flex w-full cursor-pointer flex-col items-start rounded-xl border border-line bg-paper-raised px-3.5 py-2.5 text-left transition-colors hover:border-ink",
                    )}
                  >
                    <span className="text-[15px] font-medium text-ink">
                      {client.displayName}
                    </span>
                    {client.email || client.phone ? (
                      <span className="text-[13px] text-ink-muted">
                        {[client.email, client.phone]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </div>
  );
}

"use client";

import { useMemo, useState, type ReactNode, type Ref } from "react";

import { Notice } from "@/components/ui/notice";
import {
  countServices,
  resultLine,
  searchable,
  searchCatalog,
  wordsOf,
} from "@/features/catalog/search";

import type { BookingFormat } from "../formats";
import type { BookingFlow } from "../client/use-booking-flow";
import { serviceFromLine, StepHeading } from "./booking-parts";

/**
 * Step 1: one of her services, as her catalogue shows them: her visible
 * categories in her order, each with its services, then those without a
 * category, without a heading. Only what the server returned.
 *
 * From SEARCH_FROM services, a field finds one by name, category or a word
 * of its description or questions (Higani point 37, catalog/search.ts):
 * the results replace the list, in her order, whatever the format (guided
 * included: a search goes past the choice of a category).
 */
export function ServiceStep({
  flow,
  headingRef,
  format = "classic",
  gallery,
}: {
  format?: BookingFormat;
  gallery?: ReactNode;
  flow: BookingFlow;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const { services, notice, service, catalog } = flow;
  const [category, setCategory] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const offered = searchable(catalog.groups);
  const searching = wordsOf(query).length > 0;
  const found = useMemo(
    () => searchCatalog(catalog.groups, query),
    [catalog.groups, query],
  );
  const grouped =
    format === "guided" && catalog.groups.length > 1 && !searching;
  const groups = searching
    ? found
    : grouped
      ? catalog.groups.filter(
          (group) => (group.category?.id ?? "none") === category,
        )
      : catalog.groups;
  const count = countServices(found);
  return (
    <section aria-labelledby="booking-service" className="flex flex-col gap-4">
      <div id="booking-service">
        <StepHeading
          step={flow.stepNumber("service")}
          total={flow.stepCount}
          headingRef={headingRef}
        >
          {grouped && !groups.length
            ? "Quelle catégorie vous intéresse ?"
            : "Choisissez une prestation"}
        </StepHeading>
      </div>

      {notice === "service_unavailable" ? (
        <Notice tone="warning" title="Prestation plus proposée">
          Elle n’est plus disponible à la réservation. Voici les prestations
          proposées actuellement ; vos coordonnées sont conservées.
        </Notice>
      ) : null}

      {format === "showcase" ? gallery : null}
      {offered ? (
        <div role="search" className="flex flex-col gap-1">
          <label className="flex h-12 items-center gap-3 rounded-2xl border border-line bg-paper-raised px-4 text-ink focus-within:border-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink">
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              className="size-[18px] shrink-0 text-ink-soft"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m12.6 12.6 4.4 4.4" strokeLinecap="round" />
            </svg>
            <span className="sr-only">Rechercher une prestation</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Nom, catégorie ou mot-clé"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              // 16px: a phone does not zoom into the field.
              className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-ink-muted"
            />
          </label>
          <p role="status" className="min-h-5 text-sm text-ink-soft">
            {searching ? resultLine(count, query) : null}
          </p>
          {searching && count === 0 ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="min-h-11 self-start text-sm underline underline-offset-4"
            >
              Effacer la recherche
            </button>
          ) : null}
        </div>
      ) : null}
      {grouped && groups.length > 0 ? (
        <button
          type="button"
          onClick={() => setCategory(undefined)}
          className="min-h-11 self-start text-sm underline underline-offset-4"
        >
          Toutes les catégories
        </button>
      ) : null}
      {grouped && !groups.length ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {catalog.groups.map((group) => (
            <button
              key={group.category?.id ?? "none"}
              type="button"
              onClick={() => setCategory(group.category?.id ?? "none")}
              className="rounded-xl border border-line bg-paper-raised p-4 text-left font-semibold text-ink hover:border-ink"
            >
              {group.category?.name ?? "Autres prestations"}
              <span className="block text-sm font-normal text-ink-soft">
                {group.services.length} prestation
                {group.services.length > 1 ? "s" : ""}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {services.length === 0 ? (
        <Notice tone="info" title="Aucune prestation en ligne">
          Cet établissement ne propose pas encore de prestation à réserver en
          ligne.
        </Notice>
      ) : (
        groups.map((group) => (
          <div
            key={group.category?.id ?? "none"}
            className="flex flex-col gap-3"
          >
            {group.category ? (
              <h3 className="pt-2 font-display text-[22px] leading-tight wrap-anywhere text-ink">
                {group.category.name}
              </h3>
            ) : null}
            <ul
              className={
                format === "showcase"
                  ? "grid gap-3 sm:grid-cols-2"
                  : "flex flex-col gap-3"
              }
              aria-label={group.category?.name ?? "Prestations"}
            >
              {group.services.map(({ id }) => {
                const item = services.find((entry) => entry.id === id)!;
                const selected = item.id === service?.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => flow.actions.chooseService(item.id)}
                      aria-pressed={selected}
                      aria-describedby={`service-${item.id}-details`}
                      className="flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-3xl border border-line bg-paper-raised px-4 py-4 text-left transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink aria-pressed:border-ink sm:px-5"
                    >
                      <span className="text-[17px] font-semibold wrap-anywhere text-ink">
                        {item.name}
                      </span>
                      <span
                        id={`service-${item.id}-details`}
                        className="flex flex-col gap-1"
                      >
                        <span className="text-[14.5px] text-ink-soft">
                          {serviceFromLine(item)}
                        </span>
                        {item.description ? (
                          <span className="text-[14px] leading-snug wrap-anywhere whitespace-pre-line text-ink-muted">
                            {item.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

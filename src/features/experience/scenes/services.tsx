"use client";
import { bookingLabel, sectionTitle } from "@/features/sites/presentation";

import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";

import {
  countServices,
  resultLine,
  searchable,
  searchCatalog,
  wordsOf,
} from "@/features/catalog/search";

import {
  startingAt,
  type CatalogService,
  type ShowcaseGroup,
} from "../catalog/model";
import type { ServicesVariant } from "../engine/config";
import { nextLabel } from "../next-slot";
import {
  Detail,
  Display,
  Note,
  type EngineEdit,
  euros,
  minutes,
  price,
  useEngine,
  useReveal,
} from "../engine/engine";

// Her services, each one a direct way into booking (no account). Three
// compositions — a price index, a shelf of rituals, colour tiles — that
// show HER catalogue, whatever its shape: two categories or fifteen, one
// service or dozens, short or long names, no category at all, nothing
// yet. Empty or hidden categories never reach a scene (catalog/model.ts):
// a scene only decides how groups look, never which exist.

export function Services({
  variant,
  index,
}: {
  variant: ServicesVariant;
  index: number;
}) {
  const { catalog } = useEngine();
  if (!catalog.length) return <Empty variant={variant} />;
  if (variant === "shelf") return <Shelf />;
  if (variant === "tiles") return <Tiles />;
  return <PriceIndex index={index} />;
}

/**
 * Each service's place in her whole list (continuous numbering): its
 * number, and its colour among the tiles, stay the same while she searches.
 */
const numbersOf = (groups: ShowcaseGroup[]) =>
  new Map(
    groups
      .flatMap((group) => group.services)
      .map((service, index) => [service.id, index + 1]),
  );

// A long catalogue can be searched (Higani point 37): by name, category or a
// word of the description or of a booking question (catalog/search.ts).
// What is shown is her catalogue filtered, in her order; her numbering
// stays. Below SEARCH_FROM services there is no field: the list is short.
function useSearch(catalog: ShowcaseGroup[]) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => searchCatalog(catalog, query), [catalog, query]);
  return {
    offered: searchable(catalog),
    query,
    setQuery,
    groups,
    active: wordsOf(query).length > 0,
  };
}

type Search = ReturnType<typeof useSearch>;

/** The search field, drawn in the scene's own colours (currentColor). */
function SceneSearch({ search }: { search: Search }) {
  if (!search.offered) return null;
  const count = countServices(search.groups);
  return (
    <div role="search" className="mt-6">
      <label
        className="flex h-12 items-center gap-3 border border-current/45 px-4 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-current"
        style={{ borderRadius: "min(var(--s-control), 22px)" }}
      >
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="size-[18px] shrink-0"
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
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          placeholder="Nom, catégorie ou mot-clé"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          // 16px: a phone does not zoom into the field.
          className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-current placeholder:opacity-60"
        />
      </label>
      <p role="status" className="mt-2 min-h-5">
        {search.active ? <Note>{resultLine(count, search.query)}</Note> : null}
      </p>
      {search.active && count === 0 ? (
        <button
          type="button"
          onClick={() => search.setQuery("")}
          className="min-h-11 cursor-pointer underline underline-offset-4"
        >
          <Note>Effacer la recherche</Note>
        </button>
      ) : null}
    </div>
  );
}

/** Long names get a smaller size instead of breaking the composition. */
const long = (name: string) => name.length > 38;

/** From four headings on, a row of shortcuts to jump to a category. */
function CategoryNav({ groups }: { groups: ShowcaseGroup[] }) {
  const named = groups.filter((group) => group.category);
  if (named.length < 4) return null;
  return (
    <nav aria-label="Catégories" className="-mx-5 mt-6 md:mx-0">
      <ul className="flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none] md:flex-wrap md:px-0">
        {named.map((group) => (
          <li key={group.category!.id} className="shrink-0">
            <a
              href={`#categorie-${group.category!.id}`}
              className="flex h-11 items-center border border-current/30 px-4 whitespace-nowrap"
              style={{ borderRadius: "min(var(--s-control), 22px)" }}
            >
              <Note>{group.category!.name}</Note>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** In the studio: the service being edited, outlined in the preview. */
function editMark(
  edit: EngineEdit | undefined,
  service: CatalogService,
  base: string,
) {
  if (!edit) return { className: base };
  return {
    "data-service": service.id,
    className:
      `${base} ` +
      (edit.selectedService === service.id
        ? "outline-4 outline-offset-2 outline-current"
        : "outline-2 outline-offset-2 outline-current/35 outline-dashed"),
  };
}

/** "Avez-vous besoin d’une dépose ?": the questions asked when booking. */
function OptionsNote({ service }: { service: CatalogService }) {
  if (!service.options.length) return null;
  return (
    <Note>
      À la réservation :{" "}
      {service.options.map((option) => option.question).join(" · ")}
    </Note>
  );
}

/** Her next slot for this service (Higani point 2), when she has one. */
function NextSlotNote({
  service,
  className = "",
}: {
  service: CatalogService;
  className?: string;
}) {
  const { next, today } = useEngine();
  const slot = next?.[service.id];
  if (!slot || !today) return null;
  return (
    <span className={`block ${className}`}>
      <Note>Prochaine dispo · {nextLabel(slot.localStartsAt, today)}</Note>
    </span>
  );
}

// Her price and duration as her booking page says them: at least, "dès"
// when an answer can add to them (startingAt).
function priceOf(service: CatalogService) {
  const from = startingAt(service);
  return from.priceVaries
    ? `dès ${euros(from.priceCents, service.currency)}`
    : price(from.priceCents, service.currency);
}

function minutesOf(service: CatalogService) {
  const from = startingAt(service);
  return `${from.durationVaries ? "dès " : ""}${minutes(from.durationMinutes)}`;
}

function PriceIndex({ index }: { index: number }) {
  const { config, catalog, book, edit, motion: language } = useEngine();
  // Several can be open at once (Higani point 36): she reads two close
  // services one under the other, without closing one to open the other.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const numbers = numbersOf(catalog);
  const search = useSearch(catalog);
  return (
    <section
      data-booking-scene
      className="bg-[var(--u-paper)] text-[var(--u-ink-on-paper)]"
    >
      <div className="mx-auto max-w-[1100px] px-5 pt-16 pb-40">
        <div className="flex items-baseline justify-between border-t border-current pt-4">
          {sectionTitle(config.presentation, "services", "Prestations") && (
            <Detail>
              ({String(index).padStart(2, "0")}){" "}
              {sectionTitle(config.presentation, "services", "Prestations")}
            </Detail>
          )}
          <Detail>Prix TTC</Detail>
        </div>
        <SceneSearch search={search} />
        {search.active ? null : <CategoryNav groups={catalog} />}
        {search.groups.map((group) => (
          <div
            key={group.category?.id ?? "sans-categorie"}
            id={group.category ? `categorie-${group.category.id}` : undefined}
            className="mt-10 scroll-mt-20 first-of-type:mt-6"
          >
            {group.category ? (
              <h3 className="flex items-baseline justify-between gap-4 pb-1 text-[var(--u-soft-paper)]">
                <Detail className="[overflow-wrap:anywhere]">
                  {group.category.name}
                </Detail>
                <Detail>{group.services.length}</Detail>
              </h3>
            ) : null}
            <ol>
              {group.services.map((service) => {
                const number = numbers.get(service.id)!;
                const expanded = open.has(service.id);
                return (
                  <li
                    key={service.id}
                    {...editMark(
                      edit,
                      service,
                      "scroll-mt-24 border-b border-current/80",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        edit ? edit.service(service.id) : toggle(service.id)
                      }
                      aria-expanded={edit ? undefined : expanded}
                      className="grid w-full cursor-pointer grid-cols-[2.2rem_1fr_auto] items-baseline gap-x-2 py-5 text-left"
                    >
                      <Detail>{String(number).padStart(2, "0")}</Detail>
                      <Display
                        className={`hyphens-auto [overflow-wrap:anywhere] ${long(service.name) ? "text-[22px] leading-[1.1] md:text-[30px]" : "text-[30px] leading-[1.02] md:text-[44px]"}`}
                      >
                        {service.name}
                      </Display>
                      {/* Price and duration at first sight (point 34):
                          the row says what she commits to before it opens. */}
                      <span className="flex flex-col items-end gap-1 text-right">
                        <Detail>{priceOf(service)}</Detail>
                        <span className="text-[var(--u-soft-paper)]">
                          <Detail>{minutesOf(service)}</Detail>
                        </span>
                      </span>
                    </button>
                    <AnimatePresence initial={false}>
                      {expanded ? (
                        <motion.div
                          initial={{ height: 0 }}
                          animate={{ height: "auto" }}
                          exit={{ height: 0 }}
                          transition={{ duration: 0.45, ease: language.ease }}
                          className="overflow-hidden"
                        >
                          <div className="grid grid-cols-[2.2rem_1fr] gap-x-2 pb-6">
                            <span />
                            <div className="flex flex-col gap-4">
                              {service.description ? (
                                <p className="max-w-[40ch] text-[16px] leading-relaxed">
                                  {service.description}
                                </p>
                              ) : null}
                              <OptionsNote service={service} />
                              <NextSlotNote service={service} />
                              <div className="flex flex-wrap items-center justify-end gap-3">
                                <button
                                  type="button"
                                  onClick={() => book(service)}
                                  className="cursor-pointer bg-[var(--u-ink-on-paper)] px-4 py-3 text-[var(--u-paper)]"
                                  style={{ borderRadius: "var(--s-control)" }}
                                >
                                  <Detail>
                                    {bookingLabel(
                                      config.presentation,
                                      "Réserver ce soin",
                                    )}{" "}
                                    →
                                  </Detail>
                                </button>
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

function Shelf() {
  const { config, catalog, book, edit } = useEngine();
  const reveal = useReveal();
  const search = useSearch(catalog);
  return (
    <section
      data-booking-scene
      className="bg-[var(--u-paper)] pt-20 pb-36 text-[var(--u-ink-on-paper)]"
    >
      <div className="mx-auto max-w-[1100px] px-6">
        {!config.presentation?.labels?.services?.hideTitle && (
          <motion.h2
            className="text-[44px] leading-none [overflow-wrap:anywhere] md:text-[64px]"
            {...reveal()}
          >
            <Display>
              {sectionTitle(config.presentation, "services", "Rituels")}
            </Display>
          </motion.h2>
        )}
        <p className="mt-3 max-w-[38ch] text-[15.5px] leading-relaxed text-[var(--u-soft-paper)]">
          Le temps indiqué est le vôtre : on ne le raccourcit pas.
        </p>
        <SceneSearch search={search} />
        {search.active ? null : <CategoryNav groups={catalog} />}
      </div>
      {search.groups.map((group) => (
        <div
          key={group.category?.id ?? "sans-categorie"}
          id={group.category ? `categorie-${group.category.id}` : undefined}
          className="mt-12 scroll-mt-16"
        >
          {group.category ? (
            <div className="mx-auto flex max-w-[1100px] items-baseline justify-between gap-4 px-6">
              <Display
                as="h3"
                className="text-[28px] leading-[1.05] [overflow-wrap:anywhere] md:text-[36px]"
              >
                {group.category.name}
              </Display>
              <Note className="shrink-0 text-[var(--u-soft-paper)]">
                {group.services.length > 1
                  ? `${group.services.length} rituels`
                  : "1 rituel"}
              </Note>
            </div>
          ) : null}
          <ul className="mt-5 flex snap-x snap-mandatory gap-4 overflow-x-auto px-6 pb-4 [scrollbar-width:none] md:mx-auto md:max-w-[1100px]">
            {group.services.map((service, position) => (
              <motion.li
                key={service.id}
                {...editMark(
                  edit,
                  service,
                  "w-[78vw] max-w-[340px] shrink-0 snap-center scroll-mt-24",
                )}
                {...reveal(position)}
              >
                <article
                  className="flex h-full flex-col justify-between gap-10 bg-[var(--u-card)] p-6 text-[var(--u-ink-card)]"
                  style={{ borderRadius: "var(--s-radius)" }}
                >
                  <div>
                    <span className="text-[var(--u-soft-card)]">
                      <Note>{minutesOf(service)} pour vous</Note>
                    </span>
                    <Display
                      as="h4"
                      className={`mt-3 block hyphens-auto [overflow-wrap:anywhere] ${long(service.name) ? "text-[24px] leading-[1.1]" : "text-[32px] leading-[1.05]"}`}
                    >
                      {service.name}
                    </Display>
                    {service.description ? (
                      <p className="mt-4 text-[15px] leading-relaxed text-[var(--u-soft-card)]">
                        {service.description}
                      </p>
                    ) : null}
                    {service.options.length ? (
                      <p className="mt-3">
                        <OptionsNote service={service} />
                      </p>
                    ) : null}
                    <NextSlotNote service={service} className="mt-3" />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[17px] tabular-nums">
                      {priceOf(service)}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        edit ? edit.service(service.id) : book(service)
                      }
                      className="cursor-pointer bg-[var(--u-ink-on-paper)] px-5 py-3 text-[14.5px] text-[var(--u-paper)]"
                      style={{ borderRadius: "var(--s-control)" }}
                    >
                      {edit ? "Modifier" : bookingLabel(config.presentation)}
                    </button>
                  </div>
                </article>
              </motion.li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** Colour tiles: each service a bold block, booked in one tap. */
function Tiles() {
  const { config, catalog, book, edit } = useEngine();
  const reveal = useReveal();
  const tones = [
    "bg-[var(--u-accent)] text-[var(--u-on-accent)]",
    "bg-[var(--u-paper)] text-[var(--u-ink-on-paper)]",
    "bg-[var(--u-ink)] text-[var(--u-bg)]",
  ];
  // A long menu gets denser tiles: the rhythm stays, the scroll shortens.
  const dense = countServices(catalog) > 10;
  const numbers = numbersOf(catalog);
  const search = useSearch(catalog);
  return (
    <section
      data-booking-scene
      className="bg-[var(--u-bg)] px-3 pt-16 pb-36 text-[var(--u-ink)]"
    >
      <div className="mx-auto max-w-[1100px] px-2">
        {!config.presentation?.labels?.services?.hideTitle && (
          <motion.h2
            className="text-[clamp(48px,15vw,140px)] leading-[0.85] [overflow-wrap:anywhere]"
            {...reveal()}
          >
            <Display>
              {sectionTitle(config.presentation, "services", "Le menu")}
            </Display>
          </motion.h2>
        )}
        <SceneSearch search={search} />
        {search.active ? null : <CategoryNav groups={catalog} />}
      </div>
      {search.groups.map((group) => (
        <div
          key={group.category?.id ?? "sans-categorie"}
          id={group.category ? `categorie-${group.category.id}` : undefined}
          className="mx-auto mt-10 max-w-[1100px] scroll-mt-16"
        >
          {group.category ? (
            <div className="flex items-end justify-between gap-4 px-2 pb-3">
              <Display
                as="h3"
                className="text-[30px] leading-[0.95] [overflow-wrap:anywhere] md:text-[44px]"
              >
                {group.category.name}
              </Display>
              <Detail>{String(group.services.length).padStart(2, "0")}</Detail>
            </div>
          ) : null}
          <ul className="grid gap-3 md:grid-cols-2">
            {group.services.map((service, position) => {
              const className =
                tones[(numbers.get(service.id)! - 1) % tones.length];
              return (
                <motion.li
                  key={service.id}
                  {...editMark(edit, service, "scroll-mt-24")}
                  {...reveal(position)}
                >
                  <button
                    type="button"
                    onClick={() =>
                      edit ? edit.service(service.id) : book(service)
                    }
                    className={`group relative flex w-full cursor-pointer flex-col justify-between gap-6 overflow-hidden p-6 text-left ${dense ? "min-h-[168px]" : "min-h-[220px]"} ${className}`}
                    style={{ borderRadius: "var(--s-radius)" }}
                  >
                    <span className="flex items-start justify-between gap-4">
                      <Detail>{minutesOf(service)}</Detail>
                      <span className="flex size-16 shrink-0 items-center justify-center rounded-full border-2 border-current text-[14px] font-semibold tabular-nums transition-transform duration-300 group-hover:rotate-12">
                        {priceOf(service)}
                      </span>
                    </span>
                    <span>
                      <Display
                        className={`block hyphens-auto [overflow-wrap:anywhere] ${long(service.name) ? "text-[26px] leading-[0.95]" : dense ? "text-[34px] leading-[0.9]" : "text-[40px] leading-[0.9]"}`}
                      >
                        {service.name}
                      </Display>
                      {service.description ? (
                        <span className="mt-3 block max-w-[34ch] text-[15px] leading-snug">
                          {service.description}
                        </span>
                      ) : null}
                      {service.options.length ? (
                        <span className="mt-2 block">
                          <OptionsNote service={service} />
                        </span>
                      ) : null}
                      <NextSlotNote service={service} className="mt-2" />
                      <span className="mt-5 inline-block">
                        <Detail>
                          {edit
                            ? "Modifier"
                            : bookingLabel(config.presentation)}{" "}
                          →
                        </Detail>
                      </span>
                    </span>
                  </button>
                </motion.li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/**
 * Nothing to book yet: the scene keeps its place and its surface (the
 * composition does not jump), and says so; in the studio, what to do.
 */
function Empty({ variant }: { variant: ServicesVariant }) {
  const { config, edit } = useEngine();
  const night = variant === "tiles";
  return (
    <section
      className={
        night
          ? "bg-[var(--u-bg)] px-5 pt-16 pb-36 text-[var(--u-ink)]"
          : "bg-[var(--u-paper)] px-5 pt-16 pb-36 text-[var(--u-ink-on-paper)]"
      }
    >
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4 border-t border-current pt-6">
        {!config.presentation?.labels?.services?.hideTitle && (
          <Display
            as="h2"
            className="text-[clamp(40px,10vw,88px)] leading-[0.95]"
          >
            {sectionTitle(config.presentation, "services", "Bientôt")}
          </Display>
        )}
        <Note
          className={`max-w-[36ch] text-[16px] ${night ? "text-[var(--u-muted)]" : "text-[var(--u-soft-paper)]"}`}
        >
          {edit
            ? "Aucune prestation en ligne pour l’instant. Ajoute-les dans le Studio, onglet « Prestations »."
            : "Les prestations arrivent très vite ici."}
        </Note>
      </div>
    </section>
  );
}

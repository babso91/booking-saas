"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import type { CatalogService, ShowcaseGroup } from "../catalog/model";
import type { ServicesVariant } from "../engine/config";
import {
  Detail,
  Display,
  Note,
  type EngineEdit,
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

/** Where each group starts in the whole list (continuous numbering). */
const offsets = (groups: ShowcaseGroup[]) =>
  groups.map((_, index) =>
    groups
      .slice(0, index)
      .reduce((sum, group) => sum + group.services.length, 0),
  );

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
    <Note className="opacity-90">
      À la réservation :{" "}
      {service.options.map((option) => option.question).join(" · ")}
    </Note>
  );
}

function PriceIndex({ index }: { index: number }) {
  const { catalog, book, edit, motion: language } = useEngine();
  const [open, setOpen] = useState<string | null>(null);
  const starts = offsets(catalog);
  return (
    <section
      data-booking-scene
      className="bg-[var(--u-paper)] text-[var(--u-ink-on-paper)]"
    >
      <div className="mx-auto max-w-[1100px] px-5 pt-16 pb-40">
        <div className="flex items-baseline justify-between border-t border-current pt-4">
          <Detail>({String(index).padStart(2, "0")}) Prestations</Detail>
          <Detail>Prix TTC</Detail>
        </div>
        <CategoryNav groups={catalog} />
        {catalog.map((group, groupIndex) => (
          <div
            key={group.category?.id ?? "sans-categorie"}
            id={group.category ? `categorie-${group.category.id}` : undefined}
            className="mt-10 scroll-mt-20 first-of-type:mt-6"
          >
            {group.category ? (
              <h3 className="flex items-baseline justify-between gap-4 pb-1 opacity-70">
                <Detail className="[overflow-wrap:anywhere]">
                  {group.category.name}
                </Detail>
                <Detail>{group.services.length}</Detail>
              </h3>
            ) : null}
            <ol>
              {group.services.map((service, position) => {
                const number = starts[groupIndex]! + position + 1;
                const expanded = open === service.id;
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
                        edit
                          ? edit.service(service.id)
                          : setOpen(expanded ? null : service.id)
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
                      <Detail>{price(service.priceCents)}</Detail>
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
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <Note>
                                  Durée {minutes(service.durationMinutes)}
                                </Note>
                                <button
                                  type="button"
                                  onClick={() => book(service)}
                                  className="cursor-pointer bg-[var(--u-ink-on-paper)] px-4 py-3 text-[var(--u-paper)]"
                                  style={{ borderRadius: "var(--s-control)" }}
                                >
                                  <Detail>Réserver ce soin →</Detail>
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
  const { catalog, book, edit } = useEngine();
  const reveal = useReveal();
  return (
    <section
      data-booking-scene
      className="bg-[var(--u-paper)] pt-20 pb-36 text-[var(--u-ink-on-paper)]"
    >
      <div className="mx-auto max-w-[1100px] px-6">
        <motion.h2
          className="text-[44px] leading-none md:text-[64px]"
          {...reveal()}
        >
          <Display>Rituels</Display>
        </motion.h2>
        <p className="mt-3 max-w-[38ch] text-[15.5px] leading-relaxed opacity-75">
          Le temps indiqué est le vôtre : on ne le raccourcit pas.
        </p>
        <CategoryNav groups={catalog} />
      </div>
      {catalog.map((group) => (
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
              <Note className="shrink-0 opacity-80">
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
                  className="flex h-full flex-col justify-between gap-10 bg-[color-mix(in_srgb,var(--u-paper)_70%,white)] p-6"
                  style={{ borderRadius: "var(--s-radius)" }}
                >
                  <div>
                    <span className="opacity-65">
                      <Note>{minutes(service.durationMinutes)} pour vous</Note>
                    </span>
                    <Display
                      as="h4"
                      className={`mt-3 block hyphens-auto [overflow-wrap:anywhere] ${long(service.name) ? "text-[24px] leading-[1.1]" : "text-[32px] leading-[1.05]"}`}
                    >
                      {service.name}
                    </Display>
                    {service.description ? (
                      <p className="mt-4 text-[15px] leading-relaxed opacity-80">
                        {service.description}
                      </p>
                    ) : null}
                    {service.options.length ? (
                      <p className="mt-3">
                        <OptionsNote service={service} />
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[17px] tabular-nums">
                      {price(service.priceCents)}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        edit ? edit.service(service.id) : book(service)
                      }
                      className="cursor-pointer bg-[var(--u-ink-on-paper)] px-5 py-3 text-[14.5px] text-[var(--u-paper)]"
                      style={{ borderRadius: "var(--s-control)" }}
                    >
                      {edit ? "Modifier" : "Réserver"}
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
  const { catalog, book, edit } = useEngine();
  const reveal = useReveal();
  const tones = [
    "bg-[var(--u-accent)] text-[var(--u-on-accent)]",
    "bg-[var(--u-paper)] text-[var(--u-ink-on-paper)]",
    "bg-[var(--u-ink)] text-[var(--u-bg)]",
  ];
  // A long menu gets denser tiles: the rhythm stays, the scroll shortens.
  const dense =
    catalog.reduce((sum, group) => sum + group.services.length, 0) > 10;
  const starts = offsets(catalog);
  return (
    <section
      data-booking-scene
      className="bg-[var(--u-bg)] px-3 pt-16 pb-36 text-[var(--u-ink)]"
    >
      <div className="mx-auto max-w-[1100px] px-2">
        <motion.h2
          className="text-[clamp(48px,15vw,140px)] leading-[0.85]"
          {...reveal()}
        >
          <Display>Le menu</Display>
        </motion.h2>
        <CategoryNav groups={catalog} />
      </div>
      {catalog.map((group, groupIndex) => (
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
                tones[(starts[groupIndex]! + position) % tones.length];
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
                      <Detail>{minutes(service.durationMinutes)}</Detail>
                      <span className="flex size-16 shrink-0 items-center justify-center rounded-full border-2 border-current text-[14px] font-semibold tabular-nums transition-transform duration-300 group-hover:rotate-12">
                        {price(service.priceCents)}
                      </span>
                    </span>
                    <span>
                      <Display
                        className={`block hyphens-auto [overflow-wrap:anywhere] ${long(service.name) ? "text-[26px] leading-[0.95]" : dense ? "text-[34px] leading-[0.9]" : "text-[40px] leading-[0.9]"}`}
                      >
                        {service.name}
                      </Display>
                      {service.description ? (
                        <span className="mt-3 block max-w-[34ch] text-[15px] leading-snug opacity-90">
                          {service.description}
                        </span>
                      ) : null}
                      {service.options.length ? (
                        <span className="mt-2 block">
                          <OptionsNote service={service} />
                        </span>
                      ) : null}
                      <span className="mt-5 inline-block">
                        <Detail>{edit ? "Modifier →" : "Réserver →"}</Detail>
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
  const { edit } = useEngine();
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
        <Display
          as="h2"
          className="text-[clamp(40px,10vw,88px)] leading-[0.95]"
        >
          Bientôt
        </Display>
        <Note className="max-w-[36ch] text-[16px] opacity-75">
          {edit
            ? "Aucune prestation en ligne pour l’instant. Ajoute-les dans le Studio, onglet « Prestations »."
            : "Les prestations arrivent très vite ici."}
        </Note>
      </div>
    </section>
  );
}

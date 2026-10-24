"use client";

import { AnimatePresence, motion } from "motion/react";
import { useId, useState, type ReactNode } from "react";

import { euros, minutes } from "../engine/engine";
import type { Part } from "../site";
import {
  addCategory,
  addService,
  eurosInput,
  limits,
  moveCategory,
  moveService,
  moveServiceTo,
  newChoice,
  newOption,
  parseEuros,
  quote,
  removeCategory,
  removeService,
  updateCategory,
  updateService,
  validate,
  type Catalog,
  type CatalogService,
  type Category,
  type ServiceOption,
} from "./model";

// The studio's "Prestations": her catalogue, managed like her photos, on
// her phone. It is business, not design: no plan limits it, no universe
// changes it, and every edit shows at once in the preview behind.
//
// One list, by category, in her order: a row is a service (touch it to
// edit it, or touch it in the preview); a category's header opens the
// category. Moving is explicit (Monter / Descendre, Catégorie): reliable
// with a thumb inside a scrolling sheet, and with a keyboard or a screen
// reader. Removing is one tap, undone just as fast. What the backend
// would refuse is flagged where it is, and blocks publishing.

type View = { kind: "list" } | { kind: "category"; id: string };

const field =
  "w-full rounded-xl border border-black/12 bg-white px-3 text-[16px] outline-none focus:border-black/50 focus:ring-2 focus:ring-black/10";

export function CatalogEditor({
  catalog,
  focus,
  onFocus,
}: {
  catalog: Part<Catalog>;
  /** The service being edited (also chosen by touching it in the preview). */
  focus: string | null;
  onFocus: (id: string | null) => void;
}) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [toast, setToast] = useState<string | null>(null);
  const value = catalog.value;
  const issues = validate(value);
  const service = focus
    ? value.services.find((item) => item.id === focus)
    : undefined;
  const category =
    view.kind === "category"
      ? value.categories.find((item) => item.id === view.id)
      : undefined;

  const say = (text: string) => {
    setToast(text);
    window.setTimeout(
      () => setToast((current) => (current === text ? null : current)),
      5000,
    );
  };

  let body: ReactNode;
  if (service) {
    body = (
      <ServiceView
        key={service.id}
        catalog={catalog}
        service={service}
        issues={issues
          .filter((issue) => issue.serviceId === service.id)
          .map((issue) => issue.text)}
        onBack={() => onFocus(null)}
        onRemoved={(name) => {
          onFocus(null);
          say(`« ${name || "Sans nom"} » retirée du catalogue`);
        }}
        onDuplicated={onFocus}
      />
    );
  } else if (category) {
    body = (
      <CategoryView
        key={category.id}
        catalog={catalog}
        category={category}
        onBack={() => setView({ kind: "list" })}
        onRemoved={(text) => {
          setView({ kind: "list" });
          say(text);
        }}
      />
    );
  } else {
    body = (
      <ListView
        catalog={catalog}
        issues={issues}
        onService={onFocus}
        onCategory={(id) => setView({ kind: "category", id })}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {body}
      <AnimatePresence>
        {toast ? (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="sticky bottom-2 z-10 flex items-center gap-3 rounded-2xl bg-[#141414] py-2 pr-2 pl-4 text-[14px] text-white shadow-lg"
          >
            <span className="min-w-0 flex-1 truncate">{toast}</span>
            <button
              type="button"
              onClick={() => {
                catalog.undo();
                setToast(null);
              }}
              className="h-10 shrink-0 cursor-pointer rounded-full bg-white px-4 text-[13.5px] font-semibold text-[#141414]"
            >
              Annuler
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// --- The list ---------------------------------------------------------------

function ListView({
  catalog,
  issues,
  onService,
  onCategory,
}: {
  catalog: Part<Catalog>;
  issues: ReturnType<typeof validate>;
  onService: (id: string) => void;
  onCategory: (id: string) => void;
}) {
  const value = catalog.value;
  const online = value.services.filter((service) => service.active).length;
  const loose = value.services.filter(
    (service) =>
      service.categoryId === null ||
      !value.categories.some((item) => item.id === service.categoryId),
  );
  const groups: { category: Category | null; services: CatalogService[] }[] = [
    ...value.categories.map((category) => ({
      category,
      services: value.services.filter(
        (service) => service.categoryId === category.id,
      ),
    })),
    ...(loose.length ? [{ category: null, services: loose }] : []),
  ];

  return (
    <>
      <div>
        <p className="text-[13.5px] leading-snug text-black/60">
          Ton catalogue, tel que tes clientes le réservent. Il te suit dans tous
          les univers.
        </p>
        <p className="mt-1 text-[13px] leading-snug text-black/60">
          Tes prix et tes durées sont les tiens : ceux affichés ici sont des
          exemples, à remplacer.
        </p>
        <p className="mt-1 text-[12.5px] text-black/60">
          {value.categories.length} catégorie
          {value.categories.length > 1 ? "s" : ""} · {value.services.length}{" "}
          prestation{value.services.length > 1 ? "s" : ""} · {online} en ligne
        </p>
      </div>

      {issues.length ? (
        <section
          aria-label="À compléter"
          className="flex flex-col gap-1.5 rounded-2xl bg-[#FDECEA] p-3 text-[#7A1F17]"
        >
          <p className="text-[13px] font-semibold">
            À compléter avant de publier ({issues.length})
          </p>
          {issues.slice(0, 4).map((issue, index) => (
            <button
              key={index}
              type="button"
              onClick={() =>
                issue.serviceId
                  ? onService(issue.serviceId)
                  : issue.categoryId && onCategory(issue.categoryId)
              }
              className="cursor-pointer text-left text-[13px] leading-snug underline decoration-current/30 underline-offset-2"
            >
              {issue.text}
            </button>
          ))}
          {issues.length > 4 ? (
            <p className="text-[12.5px] opacity-75">
              et {issues.length - 4} autre{issues.length - 4 > 1 ? "s" : ""}
            </p>
          ) : null}
        </section>
      ) : null}

      {groups.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-black/20 p-4 text-[14px] leading-relaxed text-black/60">
          Ton catalogue est vide. Crée une première catégorie, par exemple selon
          tes techniques, tes zones ou tes formules : c’est toi qui décides.
        </p>
      ) : null}

      {groups.map(({ category, services }) => (
        <section
          key={category?.id ?? "sans-categorie"}
          aria-label={category ? category.name || "Sans nom" : "Sans catégorie"}
          className="overflow-hidden rounded-2xl border border-black/10 bg-white"
        >
          {category ? (
            <button
              type="button"
              onClick={() => onCategory(category.id)}
              className="flex min-h-14 w-full cursor-pointer items-center gap-2 border-b border-black/8 px-4 py-2 text-left"
            >
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-[15px] font-semibold [overflow-wrap:anywhere] ${category.name.trim() ? "" : "text-[#B3261E] italic"}`}
                >
                  {category.name.trim() || "Catégorie sans nom"}
                </span>
                <span className="block text-[12.5px] text-black/60">
                  {services.length} prestation{services.length > 1 ? "s" : ""}
                  {!category.visible
                    ? " · masquée sur ton site"
                    : !services.some((service) => service.active)
                      ? " · vide, invisible sur ton site"
                      : ""}
                </span>
              </span>
              <span className="text-[13px] font-medium text-black/55">
                Modifier ›
              </span>
            </button>
          ) : (
            <p className="border-b border-black/8 px-4 py-3 text-[13px] text-black/55">
              Sans catégorie · affichées à la fin, sans titre
            </p>
          )}
          <ul>
            {services.map((service) => (
              <li
                key={service.id}
                className="border-b border-black/6 last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => onService(service.id)}
                  className="flex min-h-14 w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-black/[0.03]"
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-[15px] [overflow-wrap:anywhere] ${service.name.trim() ? "" : "text-[#B3261E] italic"} ${service.active ? "" : "text-black/60"}`}
                    >
                      {service.name.trim() || "Sans nom"}
                    </span>
                    <span className="block text-[12.5px] text-black/60 tabular-nums">
                      {minutes(service.durationMinutes)} ·{" "}
                      {euros(service.priceCents)}
                      {service.options.length
                        ? ` · ${service.options.length} option${service.options.length > 1 ? "s" : ""}`
                        : ""}
                    </span>
                  </span>
                  {!service.active ? (
                    <span className="shrink-0 rounded-full bg-black/6 px-2.5 py-1 text-[12px] font-medium text-black/55">
                      Hors ligne
                    </span>
                  ) : null}
                  <span aria-hidden="true" className="text-black/30">
                    ›
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              const next = addService(catalog.value, category?.id ?? null);
              catalog.set(next.catalog);
              onService(next.id);
            }}
            className="flex h-12 w-full cursor-pointer items-center gap-2 border-t border-black/8 px-4 text-[14px] font-medium text-[#2B3BFF]"
          >
            <span aria-hidden="true">+</span> Ajouter une prestation
          </button>
        </section>
      ))}

      <button
        type="button"
        onClick={() => {
          const next = addCategory(catalog.value);
          catalog.set(next.catalog);
          onCategory(next.id);
        }}
        className="flex h-12 cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed border-black/25 text-[14px] font-semibold"
      >
        <span aria-hidden="true">+</span> Nouvelle catégorie
      </button>
    </>
  );
}

// --- A category ---------------------------------------------------------------

function CategoryView({
  catalog,
  category,
  onBack,
  onRemoved,
}: {
  catalog: Part<Catalog>;
  category: Category;
  onBack: () => void;
  onRemoved: (text: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const value = catalog.value;
  const count = value.services.filter(
    (service) => service.categoryId === category.id,
  ).length;
  const index = value.categories.findIndex((item) => item.id === category.id);
  const set = (patch: Partial<Category>, key?: string) =>
    catalog.set(updateCategory(value, category.id, patch), key);
  const name = category.name.trim() || "Sans nom";

  return (
    <>
      <Back onClick={onBack} />
      <Field
        label="Nom de la catégorie"
        hint={`${category.name.length}/${limits.categoryName}`}
        error={category.name.trim() ? null : "Donne-lui un nom."}
      >
        {(id) => (
          <input
            id={id}
            // A new category asks for its name first.
            autoFocus={!category.name}
            value={category.name}
            maxLength={limits.categoryName}
            placeholder="Ex. Extensions, Visage, Forfaits…"
            onChange={(event) =>
              set({ name: event.target.value }, `cat-${category.id}-name`)
            }
            className={`${field} h-12`}
          />
        )}
      </Field>
      <Switch
        label="Visible sur ton site"
        hint={
          category.visible
            ? count
              ? "Ses prestations en ligne sont réservables."
              : "Vide : elle n’apparaîtra qu’avec une prestation en ligne."
            : "Masquée : ni affichée, ni réservable en ligne. Rien n’est supprimé."
        }
        checked={category.visible}
        onChange={(visible) => set({ visible })}
      />
      <Order
        label={name}
        canUp={index > 0}
        canDown={index < value.categories.length - 1}
        onMove={(by) => catalog.set(moveCategory(value, category.id, by))}
      />
      {confirm && count ? (
        <div
          role="alertdialog"
          aria-label="Supprimer la catégorie"
          className="flex flex-col gap-2 rounded-2xl bg-[#FDECEA] p-3 text-[#7A1F17]"
        >
          <p className="text-[13.5px] leading-snug">
            « {name} » contient {count} prestation{count > 1 ? "s" : ""}. Que
            veux-tu en faire ?
          </p>
          <Danger
            onClick={() => {
              catalog.set(removeCategory(value, category.id, true));
              onRemoved(`« ${name} » supprimée, ses prestations sont gardées`);
            }}
          >
            Garder les prestations, sans catégorie
          </Danger>
          <Danger
            strong
            onClick={() => {
              catalog.set(removeCategory(value, category.id, false));
              onRemoved(`« ${name} » et ses ${count} prestations supprimées`);
            }}
          >
            Tout supprimer ({count} prestation{count > 1 ? "s" : ""})
          </Danger>
          <button
            type="button"
            onClick={() => setConfirm(false)}
            className="h-11 cursor-pointer rounded-full text-[13.5px] font-medium"
          >
            Annuler
          </button>
        </div>
      ) : (
        <Danger
          onClick={() => {
            if (count) {
              setConfirm(true);
              return;
            }
            catalog.set(removeCategory(value, category.id, false));
            onRemoved(`« ${name} » supprimée`);
          }}
        >
          Supprimer la catégorie
        </Danger>
      )}
    </>
  );
}

// --- A service ----------------------------------------------------------------

function ServiceView({
  catalog,
  service,
  issues,
  onBack,
  onRemoved,
  onDuplicated,
}: {
  catalog: Part<Catalog>;
  service: CatalogService;
  issues: string[];
  onBack: () => void;
  onRemoved: (name: string) => void;
  onDuplicated: (id: string) => void;
}) {
  const value = catalog.value;
  const set = (patch: Partial<CatalogService>, key?: string) =>
    catalog.set(updateService(value, service.id, patch), key);
  const key = (name: string) => `srv-${service.id}-${name}`;
  const siblings = value.services.filter(
    (item) => item.categoryId === service.categoryId,
  );
  const position = siblings.findIndex((item) => item.id === service.id);
  const setOption = (option: ServiceOption, name?: string) =>
    set(
      {
        options: service.options.map((item) =>
          item.id === option.id ? option : item,
        ),
      },
      name ? key(`${option.id}-${name}`) : undefined,
    );
  const most = quote(
    service,
    Object.fromEntries(
      service.options.map((option) => [
        option.id,
        option.choices.at(-1)?.id ?? "",
      ]),
    ),
  );

  return (
    <>
      <Back onClick={onBack} />
      {issues.length ? (
        <ul className="flex flex-col gap-1 rounded-2xl bg-[#FDECEA] p-3 text-[13px] leading-snug text-[#7A1F17]">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}

      <Field label="Nom" hint={`${service.name.length}/${limits.name}`}>
        {(id) => (
          <input
            id={id}
            autoFocus={!service.name}
            value={service.name}
            maxLength={limits.name}
            placeholder="Ex. Volume russe, Demi-jambes…"
            onChange={(event) => set({ name: event.target.value }, key("name"))}
            className={`${field} h-12`}
          />
        )}
      </Field>
      <Field
        label="Description"
        hint={`${service.description.length}/${limits.description} · facultative`}
      >
        {(id) => (
          <textarea
            id={id}
            value={service.description}
            maxLength={limits.description}
            rows={3}
            onChange={(event) =>
              set({ description: event.target.value }, key("description"))
            }
            className={`${field} resize-none py-2.5`}
          />
        )}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Prix">
          {(id) => (
            <Money
              id={id}
              cents={service.priceCents}
              onChange={(priceCents) => set({ priceCents }, key("price"))}
            />
          )}
        </Field>
        <Field label="Durée">
          {(id) => (
            <Duration
              id={id}
              value={service.durationMinutes}
              min={limits.minDuration}
              max={limits.maxDuration}
              onChange={(durationMinutes) => set({ durationMinutes })}
            />
          )}
        </Field>
      </div>

      <Switch
        label="Réservable en ligne"
        hint={
          service.active
            ? "Affichée sur ton site et réservable."
            : "Hors ligne : gardée dans ton catalogue, invisible pour tes clientes."
        }
        checked={service.active}
        onChange={(active) => set({ active })}
      />

      <Field label="Catégorie">
        {(id) => (
          <select
            id={id}
            value={service.categoryId ?? ""}
            onChange={(event) =>
              catalog.set(
                moveServiceTo(value, service.id, event.target.value || null),
              )
            }
            className={`${field} h-12`}
          >
            {value.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name.trim() || "Catégorie sans nom"}
                {category.visible ? "" : " (masquée)"}
              </option>
            ))}
            <option value="">Sans catégorie</option>
          </select>
        )}
      </Field>
      <Order
        label={service.name.trim() || "cette prestation"}
        canUp={position > 0}
        canDown={position < siblings.length - 1}
        onMove={(by) => catalog.set(moveService(value, service.id, by))}
      />

      <section
        aria-label="Options"
        className="flex flex-col gap-3 border-t border-black/10 pt-4"
      >
        <div>
          <p className="text-[15px] font-semibold">Options</p>
          <p className="text-[13px] leading-snug text-black/55">
            Une question posée à la réservation, avec un supplément et, si tu le
            souhaites, du temps en plus. Ex. « Avez-vous besoin d’une dépose ? »
          </p>
        </div>
        {service.options.map((option) => (
          <OptionEditor
            key={option.id}
            option={option}
            onChange={setOption}
            onRemove={() =>
              set({
                options: service.options.filter(
                  (item) => item.id !== option.id,
                ),
              })
            }
          />
        ))}
        {service.options.length ? (
          <p className="text-[13px] text-black/55 tabular-nums">
            De {euros(service.priceCents)} · {minutes(service.durationMinutes)}{" "}
            à {euros(most.priceCents)} · {minutes(most.durationMinutes)} selon
            les réponses (la dernière réponse de chaque option).
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => set({ options: [...service.options, newOption()] })}
          className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-full bg-black/5 text-[14px] font-medium"
        >
          <span aria-hidden="true">+</span> Ajouter une option
        </button>
      </section>

      <div className="flex flex-col gap-2 border-t border-black/10 pt-4">
        <button
          type="button"
          onClick={() => {
            const next = addService(value, service.categoryId, service);
            catalog.set(next.catalog);
            onDuplicated(next.id);
          }}
          className="h-11 cursor-pointer rounded-full bg-black/5 text-[14px] font-medium"
        >
          Dupliquer
        </button>
        <Danger
          onClick={() => {
            catalog.set(removeService(value, service.id));
            onRemoved(service.name.trim());
          }}
        >
          Retirer du catalogue
        </Danger>
      </div>
    </>
  );
}

function OptionEditor({
  option,
  onChange,
  onRemove,
}: {
  option: ServiceOption;
  onChange: (option: ServiceOption, key?: string) => void;
  onRemove: () => void;
}) {
  const setChoice = (
    id: string,
    patch: Partial<ServiceOption["choices"][number]>,
    name?: string,
  ) =>
    onChange(
      {
        ...option,
        choices: option.choices.map((choice) =>
          choice.id === id ? { ...choice, ...patch } : choice,
        ),
      },
      name ? `${id}-${name}` : undefined,
    );
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-black/10 bg-white p-3">
      <Field label="Question">
        {(id) => (
          <input
            id={id}
            autoFocus={!option.question}
            value={option.question}
            maxLength={limits.question}
            placeholder="Ex. Avez-vous besoin d’une dépose ?"
            onChange={(event) =>
              onChange({ ...option, question: event.target.value }, "question")
            }
            className={`${field} h-12`}
          />
        )}
      </Field>
      <p className="text-[12.5px] text-black/60">
        Réponses (la première est proposée par défaut)
      </p>
      <ul className="flex flex-col gap-2">
        {option.choices.map((choice, index) => (
          <li
            key={choice.id}
            className="grid grid-cols-2 gap-2 rounded-xl bg-black/[0.03] p-2"
          >
            <input
              aria-label={`Réponse ${index + 1}`}
              value={choice.label}
              maxLength={limits.choiceLabel}
              placeholder="Réponse"
              onChange={(event) =>
                setChoice(choice.id, { label: event.target.value }, "label")
              }
              className={`${field} col-span-2 h-11`}
            />
            <Money
              label={`Supplément, réponse ${index + 1}`}
              prefix="+"
              cents={choice.priceDeltaCents}
              onChange={(priceDeltaCents) =>
                setChoice(choice.id, { priceDeltaCents }, "price")
              }
            />
            <Duration
              label={`Temps en plus, réponse ${index + 1}`}
              value={choice.durationDeltaMinutes}
              min={0}
              max={limits.maxDurationDelta}
              zero="+0 min"
              onChange={(durationDeltaMinutes) =>
                setChoice(choice.id, { durationDeltaMinutes })
              }
              compact
            />
            {option.choices.length > 2 ? (
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...option,
                    choices: option.choices.filter(
                      (item) => item.id !== choice.id,
                    ),
                  })
                }
                className="col-span-2 h-9 cursor-pointer text-left text-[13px] font-medium text-[#B3261E]"
              >
                Retirer cette réponse
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            onChange({ ...option, choices: [...option.choices, newChoice()] })
          }
          className="h-10 cursor-pointer rounded-full bg-black/5 px-4 text-[13.5px] font-medium"
        >
          + Une réponse
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="h-10 cursor-pointer rounded-full px-4 text-[13.5px] font-medium text-[#B3261E]"
        >
          Supprimer l’option
        </button>
      </div>
    </div>
  );
}

// --- Controls ---------------------------------------------------------------------

function Back({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-2 flex h-11 w-fit cursor-pointer items-center gap-1 rounded-full px-2 text-[14px] font-semibold"
    >
      <span aria-hidden="true">‹</span> Prestations
    </button>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium text-black/65">
          {label}
        </label>
        {hint ? (
          <span className="text-[12px] text-black/60 tabular-nums">{hint}</span>
        ) : null}
      </span>
      {children(id)}
      {error ? <p className="text-[13px] text-[#B3261E]">{error}</p> : null}
    </div>
  );
}

/**
 * An amount in euros, as she types it ("25", "12,50"). What she types is
 * kept while it is not an amount yet (and said so); a valid amount is
 * saved at once. An outside change (undo) shows the saved amount again.
 */
function Money({
  id,
  label,
  prefix,
  cents,
  onChange,
}: {
  id?: string;
  label?: string;
  prefix?: string;
  cents: number;
  onChange: (cents: number) => void;
}) {
  const [state, setState] = useState({ text: eurosInput(cents), cents });
  if (state.cents !== cents && parseEuros(state.text) !== cents) {
    setState({ text: eurosInput(cents), cents });
  }
  const invalid = parseEuros(state.text) === null;
  return (
    <span className="flex flex-col gap-1">
      <span className="relative flex items-center">
        {prefix ? (
          <span className="pointer-events-none absolute left-3 text-[15px] text-black/60">
            {prefix}
          </span>
        ) : null}
        <input
          id={id}
          aria-label={label}
          inputMode="decimal"
          value={state.text}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            const text = event.target.value;
            const parsed = parseEuros(text);
            setState({ text, cents: parsed ?? state.cents });
            if (parsed !== null) onChange(parsed);
          }}
          className={`${field} h-11 tabular-nums ${prefix ? "pl-6" : ""} pr-8 ${invalid ? "border-[#B3261E]" : ""}`}
        />
        <span className="pointer-events-none absolute right-3 text-[15px] text-black/60">
          €
        </span>
      </span>
      {invalid ? (
        <span className="text-[12px] text-[#B3261E]">Ex. 25 ou 12,50</span>
      ) : null}
    </span>
  );
}

/** Hours and minutes as two native pickers (wheels on a phone). */
function Duration({
  id,
  label,
  value,
  min,
  max,
  zero,
  compact,
  onChange,
}: {
  id?: string;
  label?: string;
  value: number;
  min: number;
  max: number;
  zero?: string;
  compact?: boolean;
  onChange: (minutes: number) => void;
}) {
  const steps: number[] = [];
  for (let step = min; step <= max; step += 5) steps.push(step);
  if (!steps.includes(value)) steps.push(value);
  steps.sort((a, b) => a - b);
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className={`${field} ${compact ? "h-11" : "h-11"} tabular-nums`}
    >
      {steps.map((step) => (
        <option key={step} value={step}>
          {step === 0 && zero ? zero : `${zero ? "+" : ""}${minutes(step)}`}
        </option>
      ))}
    </select>
  );
}

function Switch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-2xl border border-black/10 bg-white px-4 py-2.5 text-left"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium">{label}</span>
        <span className="block text-[12.5px] leading-snug text-black/55">
          {hint}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${checked ? "bg-[#2B3BFF]" : "bg-black/20"}`}
      >
        <span
          className={`absolute top-0.5 size-6 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[22px]" : "translate-x-0.5"}`}
        />
      </span>
    </button>
  );
}

function Order({
  label,
  canUp,
  canDown,
  onMove,
}: {
  label: string;
  canUp: boolean;
  canDown: boolean;
  onMove: (by: -1 | 1) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 text-[13px] font-medium text-black/65">
        Position
      </span>
      <button
        type="button"
        aria-label={`Monter ${label}`}
        disabled={!canUp}
        onClick={() => onMove(-1)}
        className="h-11 cursor-pointer rounded-full bg-black/5 px-4 text-[14px] font-medium disabled:cursor-not-allowed disabled:opacity-30"
      >
        ↑ Monter
      </button>
      <button
        type="button"
        aria-label={`Descendre ${label}`}
        disabled={!canDown}
        onClick={() => onMove(1)}
        className="h-11 cursor-pointer rounded-full bg-black/5 px-4 text-[14px] font-medium disabled:cursor-not-allowed disabled:opacity-30"
      >
        ↓ Descendre
      </button>
    </div>
  );
}

function Danger({
  onClick,
  strong,
  children,
}: {
  onClick: () => void;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-11 cursor-pointer rounded-full px-4 text-[14px] font-medium ${strong ? "bg-[#B3261E] text-white" : "bg-[#B3261E]/8 text-[#B3261E]"}`}
    >
      {children}
    </button>
  );
}

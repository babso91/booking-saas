// A professional's catalogue: her categories, her services and their
// options. It is BUSINESS data, not design: it never lives in a SiteConfig
// and no universe owns it. Switching from Mila to Alma or Nail Lab changes
// how it is shown, never what it contains.
//
// In the product its single source of truth is the backend (the
// `services` table: name, description, duration_minutes 5–720,
// price_cents ≥ 0, active, display_order; categories and options are the
// proposed additions, docs/EXPERIENCE_ENGINE.md). In the lab it is local
// state on fictional data: these pure functions are the edits the studio
// makes, shaped so they can later become calls to that backend.
//
// Order is the order of the arrays (display_order). Nothing here names a
// trade: no category is required, none is built in.

export type OptionChoice = {
  id: string;
  label: string;
  /** Added to the service's price (cents, never negative). */
  priceDeltaCents: number;
  /** Added to its duration: 0 unless she says so, never assumed. */
  durationDeltaMinutes: number;
};

/** One question asked when booking; the first choice is the default. */
export type ServiceOption = {
  id: string;
  question: string;
  choices: OptionChoice[];
};

export type CatalogService = {
  id: string;
  /** null: not in a category (shown last, without a heading). */
  categoryId: string | null;
  name: string;
  description: string;
  durationMinutes: number;
  priceCents: number;
  /** Offered online. An inactive service stays in her catalogue. */
  active: boolean;
  options: ServiceOption[];
};

export type Category = {
  id: string;
  name: string;
  /** On the mini-site; its services are not bookable online when hidden. */
  visible: boolean;
};

export type Catalog = { categories: Category[]; services: CatalogService[] };

/** What the mini-site shows: a group per visible, non-empty category. */
export type ShowcaseGroup = {
  category: { id: string; name: string } | null;
  services: CatalogService[];
};

// The backend's limits (services table), mirrored for the studio.
export const limits = {
  name: 120,
  description: 1000,
  categoryName: 60,
  question: 120,
  choiceLabel: 60,
  minDuration: 5,
  maxDuration: 720,
  maxDurationDelta: 240,
} as const;

let counter = 0;
/** A local id (the backend assigns the real ones). */
export const localId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;

// --- What customers see -----------------------------------------------------

const bookable = (service: CatalogService) =>
  service.active && service.name.trim() !== "";

/**
 * The public projection: visible categories in her order, their active
 * services in her order; a category without any is left out (a scene never
 * draws an empty heading). Services without a category come last, as a
 * group without a heading.
 */
export function showcase(catalog: Catalog): ShowcaseGroup[] {
  const groups: ShowcaseGroup[] = [];
  for (const category of catalog.categories) {
    if (!category.visible) continue;
    const services = catalog.services.filter(
      (service) => service.categoryId === category.id && bookable(service),
    );
    if (services.length) {
      groups.push({
        category: { id: category.id, name: category.name },
        services,
      });
    }
  }
  const known = new Set(catalog.categories.map((category) => category.id));
  const loose = catalog.services.filter(
    (service) =>
      (service.categoryId === null || !known.has(service.categoryId)) &&
      bookable(service),
  );
  if (loose.length) groups.push({ category: null, services: loose });
  return groups;
}

/** Every service a customer can book, in the order they are shown. */
export const bookableServices = (catalog: Catalog) =>
  showcase(catalog).flatMap((group) => group.services);

/** Chosen choice id per option id; a missing one means the default. */
export type Picks = Record<string, string>;

export function choiceOf(option: ServiceOption, picks: Picks) {
  return (
    option.choices.find((choice) => choice.id === picks[option.id]) ??
    option.choices[0]
  );
}

/** The price and duration of a service with the customer's choices. */
export function quote(service: CatalogService, picks: Picks = {}) {
  let priceCents = service.priceCents;
  let durationMinutes = service.durationMinutes;
  for (const option of service.options) {
    const choice = choiceOf(option, picks);
    if (!choice) continue;
    priceCents += choice.priceDeltaCents;
    durationMinutes += choice.durationDeltaMinutes;
  }
  return { priceCents, durationMinutes };
}

// --- What the studio checks before publishing --------------------------------

export type Issue = { serviceId?: string; categoryId?: string; text: string };

/** The backend's rules: a catalogue with issues is not published. */
export function validate(catalog: Catalog): Issue[] {
  const issues: Issue[] = [];
  for (const category of catalog.categories) {
    const name = category.name.trim();
    if (!name) {
      issues.push({
        categoryId: category.id,
        text: "Une catégorie n’a pas de nom.",
      });
    } else if (name.length > limits.categoryName) {
      issues.push({
        categoryId: category.id,
        text: `« ${name.slice(0, 24)}… » : ${limits.categoryName} caractères au plus.`,
      });
    }
  }
  for (const service of catalog.services) {
    const label = service.name.trim()
      ? `« ${service.name.trim()} »`
      : "Une prestation";
    const add = (text: string) =>
      issues.push({ serviceId: service.id, text: `${label} : ${text}` });
    if (!service.name.trim()) add("donne-lui un nom.");
    if (service.name.length > limits.name)
      add(`nom trop long (${limits.name} caractères au plus).`);
    if (service.description.length > limits.description)
      add(
        `description trop longue (${limits.description} caractères au plus).`,
      );
    if (
      !Number.isInteger(service.durationMinutes) ||
      service.durationMinutes < limits.minDuration ||
      service.durationMinutes > limits.maxDuration
    )
      add("une durée entre 5 min et 12 h.");
    if (!Number.isInteger(service.priceCents) || service.priceCents < 0)
      add("un prix valide.");
    let longest = service.durationMinutes;
    for (const option of service.options) {
      if (!option.question.trim()) add("une option n’a pas de question.");
      if (option.choices.length < 2)
        add("une option propose au moins deux réponses.");
      if (option.choices.some((choice) => !choice.label.trim()))
        add("une réponse d’option n’a pas d’intitulé.");
      if (
        option.choices.some(
          (choice) =>
            !Number.isInteger(choice.priceDeltaCents) ||
            choice.priceDeltaCents < 0,
        )
      )
        add("un supplément d’option n’est pas valide.");
      if (
        option.choices.some(
          (choice) =>
            !Number.isInteger(choice.durationDeltaMinutes) ||
            choice.durationDeltaMinutes < 0 ||
            choice.durationDeltaMinutes > limits.maxDurationDelta,
        )
      )
        add("une durée d’option entre 0 et 4 h.");
      longest += Math.max(
        0,
        ...option.choices.map((choice) => choice.durationDeltaMinutes),
      );
    }
    if (service.options.length && longest > limits.maxDuration)
      add("avec ses options, elle dépasserait 12 h.");
  }
  return issues;
}

// --- The studio's edits (pure: each returns a new catalogue) ------------------

const reorder = <T>(items: T[], from: number, to: number) => {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length)
    return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
};

export function addCategory(catalog: Catalog, name = "") {
  const category: Category = { id: localId("cat"), name, visible: true };
  return {
    catalog: { ...catalog, categories: [...catalog.categories, category] },
    id: category.id,
  };
}

export const updateCategory = (
  catalog: Catalog,
  id: string,
  patch: Partial<Omit<Category, "id">>,
): Catalog => ({
  ...catalog,
  categories: catalog.categories.map((category) =>
    category.id === id ? { ...category, ...patch } : category,
  ),
});

export function moveCategory(
  catalog: Catalog,
  id: string,
  by: -1 | 1,
): Catalog {
  const from = catalog.categories.findIndex((category) => category.id === id);
  return {
    ...catalog,
    categories: reorder(catalog.categories, from, from + by),
  };
}

/**
 * Removes a category. Its services go with it, or stay without a category
 * (`keepServices`): she decides, nothing is lost silently.
 */
export function removeCategory(
  catalog: Catalog,
  id: string,
  keepServices: boolean,
): Catalog {
  return {
    categories: catalog.categories.filter((category) => category.id !== id),
    services: keepServices
      ? catalog.services.map((service) =>
          service.categoryId === id
            ? { ...service, categoryId: null }
            : service,
        )
      : catalog.services.filter((service) => service.categoryId !== id),
  };
}

/** A new service at the end of its category, or a copy right after `from`. */
export function addService(
  catalog: Catalog,
  categoryId: string | null,
  from?: CatalogService,
) {
  const service: CatalogService = from
    ? {
        ...from,
        id: localId("srv"),
        name: `${from.name} (copie)`.slice(0, limits.name),
        options: from.options.map((option) => ({
          ...option,
          id: localId("opt"),
          choices: option.choices.map((choice) => ({
            ...choice,
            id: localId("ch"),
          })),
        })),
      }
    : {
        id: localId("srv"),
        categoryId,
        name: "",
        description: "",
        durationMinutes: 60,
        priceCents: 0,
        active: true,
        options: [],
      };
  const services = [...catalog.services];
  const anchor = from
    ? services.findIndex((item) => item.id === from.id)
    : services.findLastIndex((item) => item.categoryId === categoryId);
  services.splice(anchor === -1 ? services.length : anchor + 1, 0, service);
  return { catalog: { ...catalog, services }, id: service.id };
}

export const updateService = (
  catalog: Catalog,
  id: string,
  patch: Partial<Omit<CatalogService, "id">>,
): Catalog => ({
  ...catalog,
  services: catalog.services.map((service) =>
    service.id === id ? { ...service, ...patch } : service,
  ),
});

/** Swaps a service with its neighbour in the same category. */
export function moveService(catalog: Catalog, id: string, by: -1 | 1): Catalog {
  const service = catalog.services.find((item) => item.id === id);
  if (!service) return catalog;
  const siblings = catalog.services
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.categoryId === service.categoryId);
  const position = siblings.findIndex(({ item }) => item.id === id);
  const target = siblings[position + by];
  if (!target) return catalog;
  const services = [...catalog.services];
  const from = siblings[position]!.index;
  [services[from], services[target.index]] = [
    services[target.index]!,
    services[from]!,
  ];
  return { ...catalog, services };
}

/** Into another category, as its last service. */
export function moveServiceTo(
  catalog: Catalog,
  id: string,
  categoryId: string | null,
): Catalog {
  const service = catalog.services.find((item) => item.id === id);
  if (!service || service.categoryId === categoryId) return catalog;
  const rest = catalog.services.filter((item) => item.id !== id);
  const last = rest.findLastIndex((item) => item.categoryId === categoryId);
  const services = [...rest];
  services.splice(last === -1 ? rest.length : last + 1, 0, {
    ...service,
    categoryId,
  });
  return { ...catalog, services };
}

export const removeService = (catalog: Catalog, id: string): Catalog => ({
  ...catalog,
  services: catalog.services.filter((service) => service.id !== id),
});

/** A yes/no question: "Non" adds nothing, "Oui" is hers to price. */
export function newOption(): ServiceOption {
  return {
    id: localId("opt"),
    question: "",
    choices: [
      {
        id: localId("ch"),
        label: "Non",
        priceDeltaCents: 0,
        durationDeltaMinutes: 0,
      },
      {
        id: localId("ch"),
        label: "Oui",
        priceDeltaCents: 0,
        durationDeltaMinutes: 0,
      },
    ],
  };
}

export const newChoice = (): OptionChoice => ({
  id: localId("ch"),
  label: "",
  priceDeltaCents: 0,
  durationDeltaMinutes: 0,
});

// --- Money as she types it ---------------------------------------------------

/** "25", "25,5", "25.50 €" → cents; null when it is not an amount. */
export function parseEuros(text: string): number | null {
  const clean = text.replace(/\s|€/g, "").replace(",", ".");
  if (!/^\d{1,5}(\.\d{0,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

/** Cents as she would type them back: "25", "12,50". */
export const eurosInput = (cents: number) =>
  cents % 100
    ? (cents / 100).toFixed(2).replace(".", ",")
    : String(cents / 100);

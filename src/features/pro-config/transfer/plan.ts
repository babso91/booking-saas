import { sameAppearance } from "@/features/preferences/model";

import type { ProConfigDocument, ProConfigPayload } from "./format";

// The dry run of a transfer: what importing `source` into `destination`
// would do, computed from two exports (the destination's read by the same
// exporter, in its own environment). Pure: it writes nothing. Applying a
// plan is a later, separately validated step (docs/PRO_CONFIG_TRANSFER.md);
// `applyToSnapshot` shows its effect on a snapshot, so that the plan of an
// applied plan can be checked to be empty (idempotence).
//
// Identifiers are never copied: a source service is linked to the
// destination service created for it (`links`, kept by the destination);
// the business and the professional are the destination's own, chosen by
// the operator after checking her identity, never matched by id.

type Business = ProConfigPayload["business"];
type Settings = ProConfigPayload["settings"];
type Service = ProConfigPayload["services"][number];
type Hours = ProConfigPayload["hours"];

export type FieldChange<T> = { field: keyof T; from: unknown; to: unknown };

export type ServiceStep =
  | { action: "create"; source: Service }
  | {
      action: "update";
      sourceId: string;
      targetId: string;
      changes: FieldChange<Service>[];
    }
  | { action: "unchanged"; sourceId: string; targetId: string };

export type ImportPlan = {
  /** Reasons not to import at all; the plan below is then empty. */
  refusals: string[];
  /** What the operator must look at before applying. */
  warnings: string[];
  business: FieldChange<Business>[];
  settings: FieldChange<Settings>[];
  services: ServiceStep[];
  /** Destination services no source service is linked to: left as they are. */
  untouchedServices: string[];
  hours:
    | { action: "replace"; expected: Hours; next: Hours }
    | { action: "unchanged" };
  memberPreferences:
    | {
        action: "set";
        appearance: NonNullable<
          ProConfigPayload["memberPreferences"]
        >["appearance"];
      }
    | { action: "unchanged" }
    | { action: "keep_destination" };
};

/** Source service id → destination service id, from earlier imports. */
export type ServiceLinks = Record<string, string>;

/** Fields copied to the destination business (never its slug: see warnings). */
const businessFields = [
  "name",
  "description",
  "phone",
  "location",
  "timezone",
  "cancellationPolicy",
] as const satisfies readonly (keyof Business)[];

const serviceFields = [
  "name",
  "description",
  "durationMinutes",
  "priceCents",
  "active",
  "displayOrder",
] as const satisfies readonly (keyof Service)[];

export function planImport(
  source: ProConfigDocument,
  destination: ProConfigDocument,
  links: ServiceLinks,
): ImportPlan {
  const refusals: string[] = [];
  if (source.source.environment === destination.source.environment) {
    refusals.push("same_environment");
  }
  if (source.settings.currency !== destination.settings.currency) {
    // Prices are amounts in a currency: never moved across currencies.
    refusals.push("currency_mismatch");
  }
  const targets = new Set(
    destination.services.map((service) => service.sourceId),
  );
  for (const targetId of Object.values(links)) {
    if (!targets.has(targetId))
      refusals.push(`link_target_missing:${targetId}`);
  }
  if (new Set(Object.values(links)).size !== Object.values(links).length) {
    refusals.push("links_not_one_to_one");
  }
  if (refusals.length > 0) {
    return {
      refusals,
      warnings: [],
      business: [],
      settings: [],
      services: [],
      untouchedServices: [],
      hours: { action: "unchanged" },
      memberPreferences: { action: "unchanged" },
    };
  }

  const warnings: string[] = [];
  if (source.business.slug !== destination.business.slug) {
    warnings.push(
      `slug_differs:${source.business.slug}→${destination.business.slug} (kept)`,
    );
  }
  if (source.assets.length > 0) warnings.push("assets_not_transferred");

  const byTarget = new Map(
    destination.services.map((service) => [service.sourceId, service]),
  );
  const services: ServiceStep[] = source.services.map((service) => {
    const targetId = links[service.sourceId];
    const target = targetId ? byTarget.get(targetId) : undefined;
    if (!targetId || !target) return { action: "create", source: service };
    const changes = differences(target, service, serviceFields);
    return changes.length === 0
      ? { action: "unchanged", sourceId: service.sourceId, targetId }
      : { action: "update", sourceId: service.sourceId, targetId, changes };
  });
  const linked = new Set(Object.values(links));

  return {
    refusals,
    warnings,
    business: differences(
      destination.business,
      source.business,
      businessFields,
    ),
    settings: differences(
      destination.settings,
      source.settings,
      Object.keys(source.settings) as (keyof Settings)[],
    ),
    services,
    untouchedServices: destination.services
      .map((service) => service.sourceId)
      .filter((id) => !linked.has(id)),
    hours: sameHours(destination.hours, source.hours)
      ? { action: "unchanged" }
      : { action: "replace", expected: destination.hours, next: source.hours },
    memberPreferences: !source.memberPreferences
      ? { action: "unchanged" }
      : destination.memberPreferences &&
          sameAppearance(
            destination.memberPreferences.appearance,
            source.memberPreferences.appearance,
          )
        ? { action: "unchanged" }
        : destination.memberPreferences
          ? // She has chosen hers in the destination already: hers win.
            { action: "keep_destination" }
          : { action: "set", appearance: source.memberPreferences.appearance },
  };
}

/** Whether the plan changes anything. */
export function planIsEmpty(plan: ImportPlan) {
  return (
    plan.refusals.length === 0 &&
    plan.business.length === 0 &&
    plan.settings.length === 0 &&
    plan.services.every((step) => step.action === "unchanged") &&
    plan.hours.action === "unchanged" &&
    plan.memberPreferences.action !== "set"
  );
}

/**
 * The destination as it would be once the plan is applied, and the links
 * it would keep. `newId` names the services it would create.
 */
export function applyToSnapshot(
  destination: ProConfigDocument,
  links: ServiceLinks,
  plan: ImportPlan,
  newId: (sourceId: string) => string,
): { destination: ProConfigDocument; links: ServiceLinks } {
  if (plan.refusals.length > 0) throw new Error("refused plan");
  const next = structuredClone(destination);
  const nextLinks = { ...links };
  for (const change of plan.business) {
    (next.business as Record<string, unknown>)[change.field] = change.to;
  }
  for (const change of plan.settings) {
    (next.settings as Record<string, unknown>)[change.field] = change.to;
  }
  for (const step of plan.services) {
    if (step.action === "create") {
      const id = newId(step.source.sourceId);
      next.services.push({ ...step.source, sourceId: id });
      nextLinks[step.source.sourceId] = id;
    } else if (step.action === "update") {
      const target = next.services.find(
        (service) => service.sourceId === step.targetId,
      )!;
      for (const change of step.changes) {
        (target as Record<string, unknown>)[change.field] = change.to;
      }
    }
  }
  if (plan.hours.action === "replace") next.hours = plan.hours.next;
  if (plan.memberPreferences.action === "set") {
    next.memberPreferences = { appearance: plan.memberPreferences.appearance };
  }
  return { destination: next, links: nextLinks };
}

function differences<T extends object>(
  current: T,
  wanted: T,
  fields: readonly (keyof T)[],
): FieldChange<T>[] {
  return fields
    .filter((field) => current[field] !== wanted[field])
    .map((field) => ({ field, from: current[field], to: wanted[field] }));
}

function sameHours(a: Hours, b: Hours) {
  const key = (hours: Hours) =>
    hours
      .map((range) => `${range.weekday}/${range.startsAt}/${range.endsAt}`)
      .sort()
      .join(",");
  return key(a) === key(b);
}

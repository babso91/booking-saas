import { quote, type PublicCatalog } from "@/features/catalog/model";
import {
  fetchAvailabilityCalendar,
  fetchPublicBusiness,
} from "@/features/public-booking/client/api";

export function calendarMonth(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new Error("Mois incorrect.");
  const first = new Date(month + "-01T12:00:00Z");
  const last = new Date(first);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return {
    from: month + "-01",
    through: last.toISOString().slice(0, 10),
    length: last.getUTCDate(),
    offset: (first.getUTCDay() + 6) % 7,
    title: first.toLocaleDateString("fr-FR", {
      month: "long",
      timeZone: "UTC",
    }),
    year: month.slice(0, 4),
  };
}

// All services share a start grid, closures, notice and buffer. A start can
// accommodate at least one public offer iff the shortest valid offer fits.
export function shortestOffer(catalog: PublicCatalog) {
  let shortest:
    { serviceId: string; choiceIds: string[]; duration: number } | undefined;
  for (const { services } of catalog.groups)
    for (const service of services) {
      const choiceIds: string[] = [];
      for (const group of service.options) {
        const first = group.choices.reduce<
          (typeof group.choices)[number] | undefined
        >(
          (best, choice) =>
            !best || choice.durationDeltaMinutes < best.durationDeltaMinutes
              ? choice
              : best,
          undefined,
        );
        if (first && (group.required || first.durationDeltaMinutes < 0))
          choiceIds.push(first.id);
      }
      const price = quote(service, choiceIds);
      if (
        price.ok &&
        (!shortest || price.durationMinutes < shortest.duration)
      ) {
        shortest = {
          serviceId: service.id,
          choiceIds,
          duration: price.durationMinutes,
        };
      }
    }
  return shortest;
}

const minutes = (time: string) =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

// The story advertises the first bookable start of each uninterrupted window.
export function timeLabels(times: string[], step: number) {
  const sorted = [...new Set(times)].sort();
  return sorted.filter(
    (time, i) => i === 0 || minutes(time) - minutes(sorted[i - 1]!) !== step,
  );
}

export async function readStory(
  slug: string,
  month: string,
  signal: AbortSignal,
) {
  const dates = calendarMonth(month);
  const profile = await fetchPublicBusiness(slug, signal);
  if (!profile.ok)
    throw new Error(
      "Impossible de charger les prestations. Réessaie dans un instant.",
    );
  const { business, catalog } = profile.data;
  const offer = shortestOffer(catalog);
  if (!offer)
    throw new Error(
      "Ajoute une prestation réservable pour partager tes disponibilités.",
    );
  const result = await fetchAvailabilityCalendar(
    slug,
    offer.serviceId,
    dates.from,
    dates.through,
    offer.choiceIds,
    signal,
  );
  if (!result.ok || result.data.days.length !== dates.length)
    throw new Error(
      "Les disponibilités n’ont pas pu être actualisées. Réessaie.",
    );
  return {
    dates,
    name: business.name,
    timezone: business.timezone,
    updated: new Date(),
    days: result.data.days.map((day) =>
      timeLabels(
        day.slots.map((slot) => slot.localStartsAt.slice(11, 16)),
        business.slotIntervalMinutes,
      ),
    ),
  };
}

export type Story = Awaited<ReturnType<typeof readStory>>;

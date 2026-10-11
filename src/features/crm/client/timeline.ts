import type { ClientTimelineEvent } from "@/features/crm/types";

// The relationship history as it is shown: newest first, grouped by the
// business-local day of each event (`occurredAt.local`), with a heading
// each time the year changes. The order of the server is kept as is.

export type TimelineDay = { date: string; events: ClientTimelineEvent[] };
export type TimelineYear = { year: string; days: TimelineDay[] };

export function groupTimeline(events: ClientTimelineEvent[]): TimelineYear[] {
  const years: TimelineYear[] = [];
  for (const event of events) {
    const date = event.occurredAt.local.slice(0, 10);
    const year = date.slice(0, 4);
    let group = years[years.length - 1];
    if (!group || group.year !== year) {
      group = { year, days: [] };
      years.push(group);
    }
    let day = group.days[group.days.length - 1];
    if (!day || day.date !== date) {
      day = { date, events: [] };
      group.days.push(day);
    }
    day.events.push(event);
  }
  return years;
}

/**
 * The contact recorded for an appointment, when it differs from the current
 * record: what was submitted then, shown as history (never as current).
 */
export function contactAtTheTime(
  snapshot: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  },
  current: {
    firstName: string;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  },
): string | null {
  const name = [snapshot.firstName, snapshot.lastName]
    .filter(Boolean)
    .join(" ");
  const currentName = [current.firstName, current.lastName]
    .filter(Boolean)
    .join(" ");
  const parts = [
    name && name !== currentName ? name : null,
    snapshot.email && snapshot.email !== current.email ? snapshot.email : null,
    snapshot.phone && snapshot.phone !== current.phone ? snapshot.phone : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

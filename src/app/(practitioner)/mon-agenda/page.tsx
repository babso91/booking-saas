import type { Metadata, Route } from "next";

import { requirePractitioner } from "@/features/auth/data/guards";
import {
  PractitionerAgenda,
  type PractitionerDay,
} from "@/features/team/components/practitioner-agenda";
import { getPractitionerAgenda } from "@/features/team/data/practitioner-agenda";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { addDaysToLocalDate } from "@/lib/time/local-date";
// An exception, for this page only: the area converts times through
// PostgreSQL (business_time), which a practitioner may not call. Until her
// agenda's function returns the day bounds and the clock itself (asked of
// Cloud), they are computed here from her business's zone.
// eslint-disable-next-line no-restricted-imports
import { localDateRangeToUtc, zonedDateOf } from "@/lib/time/zoned";

export const metadata: Metadata = { title: "Mon agenda" };

const DAYS = 7;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A practitioner's agenda (docs/TEAM_CONTRACT.md, « Rôle praticienne »):
 * seven days of her own appointments, from ?du= (her business's today by
 * default). Read through practitioner_agenda only: the professional area's
 * pages read what the server refuses her, and send her here.
 */
export default async function PractitionerAgendaPage({
  searchParams,
}: PageProps<"/mon-agenda">) {
  const state = await requirePractitioner();
  const { business } = state;
  const { du } = await searchParams;

  // A request is rendered once: its instant is the page's « now ».
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const today = zonedDateOf(new Date(now), business.timezone);
  const start =
    typeof du === "string" &&
    LOCAL_DATE.test(du) &&
    !Number.isNaN(Date.parse(`${du}T00:00:00Z`))
      ? du
      : today;
  const end = addDaysToLocalDate(start, DAYS - 1);
  const range = localDateRangeToUtc(start, end, business.timezone);

  const client = await createServerSupabaseClient();
  const visits = await getPractitionerAgenda(client, business.id, {
    from: range.startsAt,
    to: range.endsAt,
  });

  const days: PractitionerDay[] = Array.from({ length: DAYS }, (_, index) => {
    const date = addDaysToLocalDate(start, index);
    return {
      date,
      visits: visits.filter(
        (visit) => zonedDateOf(visit.startsAt, business.timezone) === date,
      ),
    };
  });

  const at = (date: string) => `/mon-agenda?du=${date}` as Route;
  return (
    <PractitionerAgenda
      businessName={business.name}
      timeZone={business.timezone}
      today={today}
      days={days}
      previousWeek={at(addDaysToLocalDate(start, -DAYS))}
      nextWeek={at(addDaysToLocalDate(start, DAYS))}
      thisWeek={start === today ? null : ("/mon-agenda" as Route)}
      serverNow={now}
    />
  );
}

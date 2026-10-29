import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { startOfWeek } from "@/features/agenda/client/dates";
import { AppShell } from "@/features/agenda/components/app-shell";
import { getAgenda } from "@/features/agenda/data/agenda";
import {
  APPEARANCE_COOKIE,
  parseAppearance,
} from "@/features/appearance/appearance";
import { requireReadyBusiness } from "@/features/auth/data/guards";
import { StudioToday } from "@/features/dashboard/components/studio-today";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { readBusinessToday } from "@/lib/time/business-time";
import { addDaysToLocalDate } from "@/lib/time/local-date";

export const metadata: Metadata = {
  title: "Aujourd’hui",
};

// "Aujourd’hui": her day at a glance. Part of the Studio style for now; in
// Classique, the agenda is her home and this address leads there.
export default async function TodayPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { business } = await requireReadyBusiness();
  const appearance = parseAppearance(
    (await cookies()).get(APPEARANCE_COOKIE)?.value,
  );
  if (appearance.style !== "studio") redirect("/app");

  // Today and now, from the calendar authority (PostgreSQL); then the week
  // around it, read exactly as the agenda reads it (RLS: members only).
  const client = await createServerSupabaseClient();
  const today = await readBusinessToday(client, business.id);
  const monday = startOfWeek(today.date);
  const agenda = await getAgenda(
    client,
    { businessId: business.id, timezone: business.timezone },
    {
      startDate: monday,
      endDate: addDaysToLocalDate(monday, 6),
      includeCancelled: false,
    },
  );

  return (
    <AppShell
      business={{ name: business.name, slug: business.slug }}
      current="today"
    >
      <StudioToday
        agenda={agenda}
        date={today.date}
        serverNow={Date.parse(today.now)}
      />
    </AppShell>
  );
}

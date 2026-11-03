import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AppShell } from "@/features/agenda/components/app-shell";
import { loadRenderedAppearance } from "@/features/appearance/server/area-appearance";
import { requireReadyBusiness } from "@/features/auth/data/guards";
import { areaIdentityOf } from "@/features/dashboard/area-identity";
import { CarnetToday } from "@/features/dashboard/carnet/carnet-today";
import { readTodayWeek } from "@/features/dashboard/data/today-week";
import { StudioToday } from "@/features/dashboard/components/studio-today";
import { EcrinToday } from "@/features/dashboard/ecrin/ecrin-today";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { readBusinessToday } from "@/lib/time/business-time";

export const metadata: Metadata = {
  title: "Aujourd’hui",
};

// "Aujourd’hui": her day at a glance, in the Studio, Écrin and Carnet styles; in
// Classique, the agenda is her home and this address leads there.
export default async function TodayPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { user, business } = await requireReadyBusiness();
  const appearance = await loadRenderedAppearance();
  if (appearance.style === "classique") redirect("/app");

  // Today and now, from the calendar authority (PostgreSQL); then the week
  // around it, read exactly as the agenda reads it, buffers from the day
  // before included (RLS: members only).
  const client = await createServerSupabaseClient();
  const today = await readBusinessToday(client, business.id);
  const agenda = await readTodayWeek(
    client,
    { businessId: business.id, timezone: business.timezone },
    today.date,
  );

  return (
    <AppShell
      identity={areaIdentityOf({ user, business })}
      business={{ name: business.name, slug: business.slug }}
      current="today"
    >
      {appearance.style === "carnet" ? (
        <CarnetToday
          agenda={agenda}
          date={today.date}
          serverNow={Date.parse(today.now)}
        />
      ) : appearance.style === "ecrin" ? (
        <EcrinToday
          agenda={agenda}
          date={today.date}
          serverNow={Date.parse(today.now)}
        />
      ) : (
        <StudioToday
          agenda={agenda}
          date={today.date}
          serverNow={Date.parse(today.now)}
        />
      )}
    </AppShell>
  );
}

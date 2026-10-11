import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { requestedDay } from "@/features/agenda/client/requested-day";
import { AgendaView } from "@/features/agenda/components/agenda-view";
import { AppShell } from "@/features/agenda/components/app-shell";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { readBusinessTime } from "@/lib/time/business-time";

export const metadata: Metadata = {
  title: "Agenda",
};

export default async function AgendaPage({ searchParams }: PageProps<"/app">) {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { business } = await requireReadyBusiness();
  const { date } = await searchParams;
  // The business's date today, from the calendar authority (PostgreSQL).
  const { today } = await readBusinessTime(
    await createServerSupabaseClient(),
    business.id,
  );

  return (
    <AppShell business={{ name: business.name, slug: business.slug }}>
      <AgendaView
        today={today}
        initialDate={requestedDay(date)}
        slug={business.slug}
      />
    </AppShell>
  );
}

import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import {
  requestedAppointment,
  requestedDay,
} from "@/features/agenda/client/requested-day";
import { AgendaView } from "@/features/agenda/components/agenda-view";
import { AppShell } from "@/features/agenda/components/app-shell";
import {
  getSetupProgress,
  setupComplete,
} from "@/features/businesses/data/setup-progress";
import { SetupChecklist } from "@/features/onboarding/components/setup-checklist";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { readBusinessTime } from "@/lib/time/business-time";

export const metadata: Metadata = {
  title: "Agenda",
};

export default async function AgendaPage({ searchParams }: PageProps<"/app">) {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { business } = await requireReadyBusiness();
  const { date, rdv } = await searchParams;
  // The business's date today, from the calendar authority (PostgreSQL).
  const client = await createServerSupabaseClient();
  const [{ today }, progress] = await Promise.all([
    readBusinessTime(client, business.id),
    // What is still to configure (services, hours), from real data.
    getSetupProgress(client, business.id),
  ]);

  return (
    <AppShell business={{ name: business.name, slug: business.slug }}>
      {setupComplete(progress) ? null : (
        <div className="shrink-0 border-b border-line bg-paper px-4 py-3 sm:px-6">
          <SetupChecklist progress={progress} compact />
        </div>
      )}
      <AgendaView
        today={today}
        initialDate={requestedDay(date)}
        initialAppointmentId={requestedAppointment(rdv)}
      />
    </AppShell>
  );
}

import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { localToday } from "@/features/agenda/client/dates";
import { AgendaView } from "@/features/agenda/components/agenda-view";
import { AppShell } from "@/features/agenda/components/app-shell";

export const metadata: Metadata = {
  title: "Agenda",
};

export default async function AgendaPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { business } = await requireReadyBusiness();

  return (
    <AppShell business={{ name: business.name, slug: business.slug }}>
      <AgendaView
        timezone={business.timezone}
        today={localToday(business.timezone)}
        slug={business.slug}
      />
    </AppShell>
  );
}

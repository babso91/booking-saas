import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { AppShell } from "@/features/agenda/components/app-shell";
import { CalendarSettings } from "@/features/calendar/components/calendar-settings";

export const metadata: Metadata = {
  title: "Google Calendar",
};

export default async function CalendarSettingsPage({
  searchParams,
}: PageProps<"/app/settings/calendar">) {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { business } = await requireReadyBusiness();
  // Set by the OAuth callback when coming back from Google.
  const { calendar } = await searchParams;

  return (
    <AppShell
      business={{ name: business.name, slug: business.slug }}
      current="calendar"
    >
      <CalendarSettings
        callbackResult={typeof calendar === "string" ? calendar : null}
      />
    </AppShell>
  );
}

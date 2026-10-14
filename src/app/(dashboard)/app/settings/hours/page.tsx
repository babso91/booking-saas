import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { AppShell } from "@/features/agenda/components/app-shell";
import { BusinessHoursEditor } from "@/features/availability/components/business-hours-editor";

export const metadata: Metadata = {
  title: "Horaires",
};

export default async function BusinessHoursPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { business } = await requireReadyBusiness();

  return (
    <AppShell
      business={{ name: business.name, slug: business.slug }}
      current="hours"
    >
      {/* The business's zone (from the session), never the browser's. */}
      <BusinessHoursEditor
        timezone={business.timezone}
        draftKey={`hours-draft:${business.id}`}
      />
    </AppShell>
  );
}

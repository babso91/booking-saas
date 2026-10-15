import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { AppShell } from "@/features/agenda/components/app-shell";
import { ServicesManager } from "@/features/services/components/services-manager";

export const metadata: Metadata = {
  title: "Prestations",
};

export default async function ServicesPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { user, business } = await requireReadyBusiness();

  return (
    <AppShell
      business={{ name: business.name, slug: business.slug }}
      current="services"
    >
      {/* Drafts belong to this identity, from the server session only. */}
      <ServicesManager scope={{ userId: user.id, businessId: business.id }} />
    </AppShell>
  );
}

import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { AppShell } from "@/features/agenda/components/app-shell";
import { AppearanceSettings } from "@/features/appearance/components/appearance-settings";

export const metadata: Metadata = {
  title: "Apparence",
};

export default async function AppearancePage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { business } = await requireReadyBusiness();

  return (
    <AppShell
      business={{ name: business.name, slug: business.slug }}
      current="appearance"
    >
      <AppearanceSettings />
    </AppShell>
  );
}

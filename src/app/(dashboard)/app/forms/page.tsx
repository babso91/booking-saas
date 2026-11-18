import type { Metadata } from "next";

import { AppShell } from "@/features/agenda/components/app-shell";
import { requireReadyBusiness } from "@/features/auth/data/guards";
import { areaIdentityOf } from "@/features/dashboard/area-identity";
import { FormsList } from "@/features/forms/forms-list";

export const metadata: Metadata = {
  title: "Formulaires",
};

export default async function FormsPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { user, business } = await requireReadyBusiness();

  return (
    <AppShell
      identity={areaIdentityOf({ user, business })}
      business={{ name: business.name, slug: business.slug }}
      current="forms"
    >
      <FormsList />
    </AppShell>
  );
}

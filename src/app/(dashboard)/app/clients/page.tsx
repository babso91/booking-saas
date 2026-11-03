import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { areaIdentityOf } from "@/features/dashboard/area-identity";
import { AppShell } from "@/features/agenda/components/app-shell";
import { parseDirectoryQuery } from "@/features/crm/client/directory-state";
import { ClientDirectory } from "@/features/crm/components/client-directory";

export const metadata: Metadata = {
  title: "Clientes",
};

export default async function ClientsPage({
  searchParams,
}: PageProps<"/app/clients">) {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { user, business } = await requireReadyBusiness();
  const initial = parseDirectoryQuery(await searchParams);

  return (
    <AppShell
      identity={areaIdentityOf({ user, business })}
      business={{ name: business.name, slug: business.slug }}
      current="clients"
    >
      <ClientDirectory
        initial={initial}
        scope={{ userId: user.id, businessId: business.id }}
      />
    </AppShell>
  );
}

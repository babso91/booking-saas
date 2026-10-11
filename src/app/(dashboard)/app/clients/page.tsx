import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
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
  const { business } = await requireReadyBusiness();
  const initial = parseDirectoryQuery(await searchParams);

  return (
    <AppShell
      business={{ name: business.name, slug: business.slug }}
      current="clients"
    >
      <ClientDirectory initial={initial} slug={business.slug} />
    </AppShell>
  );
}

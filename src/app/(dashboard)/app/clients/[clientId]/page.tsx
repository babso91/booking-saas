import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { AppShell } from "@/features/agenda/components/app-shell";
import { ClientProfile } from "@/features/crm/components/client-profile";

export const metadata: Metadata = {
  title: "Fiche cliente",
};

export default async function ClientProfilePage({
  params,
}: PageProps<"/app/clients/[clientId]">) {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { user, business } = await requireReadyBusiness();
  const { clientId } = await params;

  return (
    <AppShell
      business={{ name: business.name, slug: business.slug }}
      current="clients"
    >
      {/* A malformed id is refused by the action (client_not_found screen).
          One instance per signed-in user, business and customer, all from
          the server session: nothing typed, read or open for one (drafts,
          dialogs, pending answers) can reach another. */}
      <ClientProfile
        key={`${user.id}:${business.id}:${clientId}`}
        clientId={clientId}
        scope={{ userId: user.id, businessId: business.id }}
      />
    </AppShell>
  );
}

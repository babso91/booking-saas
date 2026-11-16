import type { Metadata } from "next";

import { HubLoyalty } from "@/features/client-hub/components/loyalty";

export const metadata: Metadata = { title: "Ma fidélité" };

export default async function ClientHubLoyaltyPage({
  params,
}: PageProps<"/espace/[businessId]/fidelite">) {
  const { businessId } = await params;
  return <HubLoyalty key={businessId} businessId={businessId} />;
}

import type { Metadata } from "next";

import { HubAppointments } from "@/features/client-hub/components/appointments";

export const metadata: Metadata = { title: "Mes rendez-vous" };

// The id only selects within what the session may see: the API refuses
// (404) any business that did not open access to this customer.
export default async function ClientHubAppointmentsPage({
  params,
}: PageProps<"/espace/[businessId]/rendez-vous">) {
  const { businessId } = await params;
  return <HubAppointments key={businessId} businessId={businessId} />;
}

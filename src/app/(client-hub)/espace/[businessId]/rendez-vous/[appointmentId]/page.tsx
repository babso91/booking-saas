import type { Metadata } from "next";

import { HubAppointmentDetail } from "@/features/client-hub/components/appointment-detail";

export const metadata: Metadata = { title: "Rendez-vous" };

// Both ids only select within what the session may see (404 otherwise).
export default async function ClientHubAppointmentPage({
  params,
}: PageProps<"/espace/[businessId]/rendez-vous/[appointmentId]">) {
  const { businessId, appointmentId } = await params;
  return (
    <HubAppointmentDetail
      key={`${businessId}:${appointmentId}`}
      businessId={businessId}
      appointmentId={appointmentId}
    />
  );
}

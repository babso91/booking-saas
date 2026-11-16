import type { Metadata } from "next";

import { HubFormPage } from "@/features/client-hub/components/hub-forms";

export const metadata: Metadata = { title: "Formulaire" };

// A form asked before her visit (docs/CLIENT_FORMS_CONTRACT.md, Hub routes),
// read and sent under the Hub session (cookie), for her confirmed account.
export default async function ClientHubFormPage({
  params,
}: PageProps<"/espace/[businessId]/formulaires/[assignmentId]">) {
  const { businessId, assignmentId } = await params;
  return (
    <HubFormPage
      key={`${businessId}:${assignmentId}`}
      businessId={businessId}
      assignmentId={assignmentId}
    />
  );
}

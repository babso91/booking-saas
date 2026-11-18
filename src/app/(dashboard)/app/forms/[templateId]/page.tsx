import type { Metadata } from "next";

import { AppShell } from "@/features/agenda/components/app-shell";
import { requireReadyBusiness } from "@/features/auth/data/guards";
import { areaIdentityOf } from "@/features/dashboard/area-identity";
import { TemplateEditorScreen } from "@/features/forms/template-editor-screen";

export const metadata: Metadata = {
  title: "Formulaire",
};

export default async function FormTemplatePage({
  params,
}: PageProps<"/app/forms/[templateId]">) {
  const { user, business } = await requireReadyBusiness();
  const { templateId } = await params;

  return (
    <AppShell
      identity={areaIdentityOf({ user, business })}
      business={{ name: business.name, slug: business.slug }}
      current="forms"
    >
      <TemplateEditorScreen
        templateId={templateId}
        businessName={business.name}
      />
    </AppShell>
  );
}

import { DomainPreview } from "@/features/domains/domain-preview";

export const metadata = { title: "Mon domaine · Aperçu" };

// Her own domain on a scripted DNS, against an in-memory server of the
// PROPOSED contract (docs/SITE_DOMAIN_PROPOSAL.md). Nothing is bought,
// resolved or issued. Like every preview, a 404 in production unless
// DASHBOARD_PREVIEW=1.
export default function DomainPreviewPage() {
  return <DomainPreview />;
}

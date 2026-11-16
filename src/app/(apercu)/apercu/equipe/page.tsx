import { TeamPreview } from "@/features/team/team-preview";

export const metadata = { title: "Équipe · Aperçu" };

// The team screen on fictional data, against an in-memory server of the
// PROPOSED contract (docs/TEAM_PROPOSAL.md). Like every preview, a 404 in
// production unless DASHBOARD_PREVIEW=1.
export default function TeamPreviewPage() {
  return <TeamPreview />;
}

import {
  SeriesPreview,
  type SeriesScenario,
} from "@/features/series/series-preview";

export const metadata = { title: "Série de rendez-vous · Aperçu" };

const SCENARIOS: SeriesScenario[] = ["automne", "printemps", "conflits"];

// The series planner on fictional data, against an in-memory server of the
// PROPOSED contract (docs/APPOINTMENT_SERIES_PROPOSAL.md).
// ?cas=automne|printemps|conflits. Like every preview, a 404 in production
// unless DASHBOARD_PREVIEW=1.
export default async function SeriesPreviewPage({
  searchParams,
}: PageProps<"/apercu/serie">) {
  const { cas } = await searchParams;
  const scenario = SCENARIOS.includes(cas as SeriesScenario)
    ? (cas as SeriesScenario)
    : "automne";
  return <SeriesPreview key={scenario} scenario={scenario} />;
}

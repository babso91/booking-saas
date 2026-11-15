import { FormPreview, type FormScenario } from "@/features/forms/form-preview";

export const metadata = { title: "Formulaire · Aperçu" };

const SCENARIOS: FormScenario[] = [
  "ouvert",
  "nouvelle-version",
  "envoye",
  "complet",
  "expire",
  "annule",
];

// The form a client fills in before her visit, on fictional data, against
// an in-memory server of the PROPOSED contract
// (docs/CLIENT_FORMS_PROPOSAL.md). ?etat=ouvert|nouvelle-version|envoye|
// complet|expire|annule. Like every preview, a 404 in production unless
// DASHBOARD_PREVIEW=1.
export default async function FormPreviewPage({
  searchParams,
}: PageProps<"/apercu/formulaire">) {
  const { etat } = await searchParams;
  const scenario = SCENARIOS.includes(etat as FormScenario)
    ? (etat as FormScenario)
    : "ouvert";
  return <FormPreview key={scenario} scenario={scenario} />;
}

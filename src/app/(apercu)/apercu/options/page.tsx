import { OptionsPreview } from "@/features/services/components/options-preview";

export const metadata = { title: "Options · Aperçu" };

// The options editor of a service on fictional data, saved in memory: to
// review it without an account. Like every preview, a 404 in production
// unless DASHBOARD_PREVIEW=1. ?vide=1: a service without options.
export default async function OptionsPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { vide } = await searchParams;
  return <OptionsPreview empty={vide === "1"} />;
}

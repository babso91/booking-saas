import { AppShell } from "@/features/agenda/components/app-shell";
import { parseAppearance } from "@/features/appearance/appearance";
import { AppearanceProvider } from "@/features/appearance/components/appearance-provider";
import { AppearanceSettings } from "@/features/appearance/components/appearance-settings";

// The appearance settings in the real shell, for a fictional business. The
// preference changes live here (as in the area) but is not read back: the
// preview starts from the default, or from ?apparence= (a cookie value,
// e.g. atelier.light.standard.-.studio).
export default async function AppearancePreviewPage({
  searchParams,
}: PageProps<"/apercu/apparence">) {
  const { apparence } = await searchParams;
  return (
    <AppearanceProvider
      initial={parseAppearance(
        typeof apparence === "string" ? apparence : undefined,
      )}
    >
      <AppShell
        business={{ name: "Studio Exemple", slug: "studio-exemple" }}
        current="appearance"
      >
        <AppearanceSettings />
      </AppShell>
    </AppearanceProvider>
  );
}

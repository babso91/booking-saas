import { AppShell } from "@/features/agenda/components/app-shell";
import { defaultAppearance } from "@/features/appearance/appearance";
import { AppearanceProvider } from "@/features/appearance/components/appearance-provider";
import { AppearanceSettings } from "@/features/appearance/components/appearance-settings";

// The appearance settings in the real shell, for a fictional business. The
// preference changes live here (as in the area) but is not read back: the
// preview always starts from the default.
export default function AppearancePreviewPage() {
  return (
    <AppearanceProvider initial={defaultAppearance}>
      <AppShell
        business={{ name: "Studio Exemple", slug: "studio-exemple" }}
        current="appearance"
      >
        <AppearanceSettings />
      </AppShell>
    </AppearanceProvider>
  );
}

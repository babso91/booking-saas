import { AppShell } from "@/features/agenda/components/app-shell";
import {
  defaultAppearance,
  parseAppearance,
} from "@/features/appearance/appearance";
import { AppearanceProvider } from "@/features/appearance/components/appearance-provider";
import { StudioAgendaPreview } from "@/features/dashboard/agenda/studio-agenda-preview";
import {
  SAMPLE_TODAY,
  sampleBusyWeek,
  sampleInstant,
  sampleNightWeek,
  sampleTrainingWeek,
  sampleWeek,
} from "@/features/dashboard/fixtures/sample-week";

export const metadata = { title: "Studio · Agenda" };

// The real Studio agenda components on a fictional week (no database).
// ?vue=jour|semaine, ?jour=YYYY-MM-DD, ?heure=HH:MM (default 14:05),
// ?jeu=charge|nuit|formation, ?apparence=<cookie value>.
export default async function StudioAgendaPreviewPage({
  searchParams,
}: PageProps<"/apercu/studio/agenda">) {
  const { heure, apparence, jour, jeu, vue } = await searchParams;
  const week =
    jeu === "charge"
      ? sampleBusyWeek
      : jeu === "nuit"
        ? sampleNightWeek
        : jeu === "formation"
          ? sampleTrainingWeek
          : sampleWeek;
  const date =
    typeof jour === "string" &&
    week.workingHours.days.some((day) => day.date === jour)
      ? jour
      : SAMPLE_TODAY;
  const time =
    typeof heure === "string" && /^\d{2}:\d{2}$/.test(heure) ? heure : "14:05";
  const appearance =
    typeof apparence === "string"
      ? { ...parseAppearance(apparence), style: "studio" as const }
      : { ...defaultAppearance, style: "studio" as const };

  return (
    <AppearanceProvider initial={appearance}>
      <AppShell
        business={{ name: "Atelier Maëlys", slug: "atelier-maelys" }}
        current="agenda"
      >
        <StudioAgendaPreview
          week={week}
          date={date}
          now={Date.parse(sampleInstant(SAMPLE_TODAY, time))}
          initialView={vue === "jour" ? "day" : "week"}
        />
      </AppShell>
    </AppearanceProvider>
  );
}

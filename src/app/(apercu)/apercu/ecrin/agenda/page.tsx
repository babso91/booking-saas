import { AppShell } from "@/features/agenda/components/app-shell";
import { SAMPLE_IDENTITY } from "@/features/dashboard/fixtures/sample-identity";
import {
  defaultAppearance,
  parseAppearance,
} from "@/features/appearance/appearance";
import { AppearanceProvider } from "@/features/appearance/components/appearance-provider";
import { EcrinAgendaPreview } from "@/features/dashboard/ecrin/ecrin-agenda-preview";
import {
  SAMPLE_TODAY,
  sampleBufferWeek,
  sampleBusyWeek,
  sampleDenseWeek,
  sampleInstant,
  sampleNightWeek,
  sampleTrainingWeek,
  sampleWeek,
} from "@/features/dashboard/fixtures/sample-week";

export const metadata = { title: "Écrin · Agenda" };

// The real Écrin agenda components on a fictional week (no database).
// ?vue=jour|semaine, ?jour=YYYY-MM-DD, ?heure=HH:MM (default 14:05),
// ?jeu=charge|nuit|formation|dense|tampon, ?apparence=<cookie value>.
export default async function EcrinAgendaPreviewPage({
  searchParams,
}: PageProps<"/apercu/ecrin/agenda">) {
  const { heure, apparence, jour, jeu, vue } = await searchParams;
  const week =
    jeu === "charge"
      ? sampleBusyWeek
      : jeu === "nuit"
        ? sampleNightWeek
        : jeu === "formation"
          ? sampleTrainingWeek
          : jeu === "dense"
            ? sampleDenseWeek
            : jeu === "tampon"
              ? sampleBufferWeek
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
      ? { ...parseAppearance(apparence), style: "ecrin" as const }
      : { ...defaultAppearance, style: "ecrin" as const };

  return (
    <AppearanceProvider initial={appearance}>
      <AppShell
        identity={SAMPLE_IDENTITY}
        business={{ name: "Atelier Maëlys", slug: "atelier-maelys" }}
        current="agenda"
      >
        <EcrinAgendaPreview
          week={week}
          date={date}
          now={Date.parse(sampleInstant(SAMPLE_TODAY, time))}
          initialView={vue === "jour" ? "day" : "week"}
        />
      </AppShell>
    </AppearanceProvider>
  );
}

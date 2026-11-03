import { AppShell } from "@/features/agenda/components/app-shell";
import { SAMPLE_IDENTITY } from "@/features/dashboard/fixtures/sample-identity";
import {
  defaultAppearance,
  parseAppearance,
} from "@/features/appearance/appearance";
import { AppearanceProvider } from "@/features/appearance/components/appearance-provider";
import { CarnetToday } from "@/features/dashboard/carnet/carnet-today";
import {
  SAMPLE_TODAY,
  sampleBusyWeek,
  sampleDenseWeek,
  sampleInstant,
  sampleNightWeek,
  sampleTrainingWeek,
  sampleWeek,
} from "@/features/dashboard/fixtures/sample-week";

export const metadata = { title: "Carnet · Aujourd’hui" };

// The real "Aujourd’hui" screen and Carnet frame, on a fictional week.
// ?jour=YYYY-MM-DD, ?heure=HH:MM (default 14:05),
// ?jeu=charge|nuit|formation|dense, ?apparence=<cookie value>.
export default async function CarnetTodayPreview({
  searchParams,
}: PageProps<"/apercu/carnet/aujourdhui">) {
  const { heure, apparence, jour, jeu } = await searchParams;
  const week =
    jeu === "charge"
      ? sampleBusyWeek
      : jeu === "nuit"
        ? sampleNightWeek
        : jeu === "formation"
          ? sampleTrainingWeek
          : jeu === "dense"
            ? sampleDenseWeek
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
      ? { ...parseAppearance(apparence), style: "carnet" as const }
      : { ...defaultAppearance, style: "carnet" as const };
  const now = Date.parse(sampleInstant(date, time));

  return (
    <AppearanceProvider initial={appearance}>
      <AppShell
        identity={SAMPLE_IDENTITY}
        business={{ name: "Atelier Maëlys", slug: "atelier-maelys" }}
        current="today"
      >
        <CarnetToday
          agenda={week}
          date={date}
          serverNow={now}
          frozenNow={now}
        />
      </AppShell>
    </AppearanceProvider>
  );
}

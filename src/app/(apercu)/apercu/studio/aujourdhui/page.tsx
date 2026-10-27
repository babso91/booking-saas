import { AppShell } from "@/features/agenda/components/app-shell";
import {
  defaultAppearance,
  parseAppearance,
} from "@/features/appearance/appearance";
import { AppearanceProvider } from "@/features/appearance/components/appearance-provider";
import { StudioToday } from "@/features/dashboard/components/studio-today";
import {
  SAMPLE_TODAY,
  sampleInstant,
  sampleWeek,
} from "@/features/dashboard/fixtures/sample-week";

export const metadata = { title: "Studio · Aujourd’hui" };

// The real "Aujourd’hui" screen and Studio frame, on a fictional week.
// ?jour=YYYY-MM-DD picks a day of that week (default Tuesday 27) and
// ?heure=HH:MM the moment (default 14:05);
// ?apparence= takes a cookie value (e.g. atelier.dark.standard.f2512e.studio).
export default async function StudioTodayPreview({
  searchParams,
}: PageProps<"/apercu/studio/aujourdhui">) {
  const { heure, apparence, jour } = await searchParams;
  const date =
    typeof jour === "string" &&
    sampleWeek.workingHours.days.some((day) => day.date === jour)
      ? jour
      : SAMPLE_TODAY;
  const time =
    typeof heure === "string" && /^\d{2}:\d{2}$/.test(heure) ? heure : "14:05";
  const appearance =
    typeof apparence === "string"
      ? { ...parseAppearance(apparence), style: "studio" as const }
      : { ...defaultAppearance, style: "studio" as const };
  const now = Date.parse(sampleInstant(date, time));

  return (
    <AppearanceProvider initial={appearance}>
      <AppShell
        business={{ name: "Atelier Maëlys", slug: "atelier-maelys" }}
        current="today"
      >
        <StudioToday
          agenda={sampleWeek}
          date={date}
          serverNow={now}
          frozenNow={now}
        />
      </AppShell>
    </AppearanceProvider>
  );
}

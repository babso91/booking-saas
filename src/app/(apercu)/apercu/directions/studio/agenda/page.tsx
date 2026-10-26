import { today, weekDays } from "@/features/directions/data";
import { StudioFrame } from "@/features/directions/studio/studio-frame";
import { StudioWeek } from "@/features/directions/studio/studio-week";

export const metadata = { title: "Le Studio · Agenda" };

export default async function StudioWeekPage({
  searchParams,
}: PageProps<"/apercu/directions/studio/agenda">) {
  const { jour } = await searchParams;
  const asked = Number(jour);
  const shown = weekDays.some((day) => day.date === asked) ? asked : today.day;
  return (
    <StudioFrame current="agenda">
      <StudioWeek shown={shown} />
    </StudioFrame>
  );
}

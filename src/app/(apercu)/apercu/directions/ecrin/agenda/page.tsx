import { today, weekDays } from "@/features/directions/data";
import { EcrinFrame } from "@/features/directions/ecrin/ecrin-frame";
import { EcrinWeek } from "@/features/directions/ecrin/ecrin-week";

export const metadata = { title: "L’Écrin · Agenda" };

export default async function EcrinWeekPage({
  searchParams,
}: PageProps<"/apercu/directions/ecrin/agenda">) {
  const { jour } = await searchParams;
  const asked = Number(jour);
  const shown = weekDays.some((day) => day.date === asked) ? asked : today.day;
  return (
    <EcrinFrame current="agenda">
      <EcrinWeek shown={shown} />
    </EcrinFrame>
  );
}

import { CarnetSheet } from "@/features/directions/carnet/carnet-sheet";
import { CarnetWeek } from "@/features/directions/carnet/carnet-week";
import { today, weekDays } from "@/features/directions/data";

export const metadata = { title: "Le Carnet · Semaine" };

export default async function CarnetWeekPage({
  searchParams,
}: PageProps<"/apercu/directions/carnet/agenda">) {
  const { jour } = await searchParams;
  const asked = Number(jour);
  const shown = weekDays.some((day) => day.date === asked) ? asked : today.day;
  return (
    <CarnetSheet current="semaine">
      <CarnetWeek shown={shown} />
    </CarnetSheet>
  );
}

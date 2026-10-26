import { CarnetSheet } from "@/features/directions/carnet/carnet-sheet";
import { CarnetToday } from "@/features/directions/carnet/carnet-today";

export const metadata = { title: "Le Carnet · Aujourd’hui" };

export default function CarnetTodayPage() {
  return (
    <CarnetSheet current="jour">
      <CarnetToday />
    </CarnetSheet>
  );
}

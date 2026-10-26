import { EcrinFrame } from "@/features/directions/ecrin/ecrin-frame";
import { EcrinToday } from "@/features/directions/ecrin/ecrin-today";

export const metadata = { title: "L’Écrin · Aujourd’hui" };

export default function EcrinTodayPage() {
  return (
    <EcrinFrame current="jour">
      <EcrinToday />
    </EcrinFrame>
  );
}

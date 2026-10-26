import { StudioFrame } from "@/features/directions/studio/studio-frame";
import { StudioToday } from "@/features/directions/studio/studio-today";

export const metadata = { title: "Le Studio · Aujourd’hui" };

export default function StudioTodayPage() {
  return (
    <StudioFrame current="jour">
      <StudioToday />
    </StudioFrame>
  );
}

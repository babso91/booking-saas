import type { ReactNode } from "react";

import { weekdayOfLocalDate } from "@/lib/time/local-date";

const labels = ["Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam.", "Dim."];

export function CalendarGrid({
  days,
  children,
}: {
  days: string[];
  children: (day: string) => ReactNode;
}) {
  const padding = days[0] ? (weekdayOfLocalDate(days[0]) + 6) % 7 : 0;
  return (
    <div className="grid grid-cols-7 gap-1">
      {labels.map((label) => (
        <span
          key={label}
          className="truncate text-center text-[11px] font-medium text-ink-muted"
        >
          {label}
        </span>
      ))}
      {Array.from({ length: padding }, (_, index) => (
        <span key={index} />
      ))}
      {days.map((day) => (
        <div key={day} className="min-w-0">
          {children(day)}
        </div>
      ))}
    </div>
  );
}

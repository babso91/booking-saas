// Fictional availability of the lab (the product reads real slots).

/** Bookable times of a day. */
export function slotsFor(day: number) {
  const base = ["09:30", "10:00", "11:30", "13:00", "14:30", "16:00", "17:30"];
  return base.filter((_, index) => (index + day) % 3 !== 0);
}

/** The next `count` days, from tomorrow: civil labels only. */
export function nextDays(count: number) {
  const format = new Intl.DateTimeFormat("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return Array.from({ length: count }, (_, index) => {
    const at = new Date();
    at.setDate(at.getDate() + index + 1);
    const [weekday, day, month] = format
      .format(at)
      .replace(/\./g, "")
      .split(" ");
    return {
      index,
      weekday: weekday!,
      day: day!,
      month: month!,
      label: `${weekday} ${day} ${month}`,
    };
  });
}

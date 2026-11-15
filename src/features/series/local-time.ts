// Wall-clock arithmetic in a named time zone, without a library: enough
// for the planner's display and for the in-memory server. The real server
// resolves times itself; nothing here decides an appointment.

const parts = (instant: Date, timeZone: string) => {
  const map = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
};

/** "YYYY-MM-DDTHH:mm" as seen on a wall clock in `timeZone`. */
export const localOf = (iso: string, timeZone: string) =>
  parts(new Date(iso), timeZone);

/**
 * Every instant that a wall clock in `timeZone` shows as `local`: one
 * normally, two when clocks go back, none when they go forward. Offsets
 * up to ±14 h are searched by quarter hour.
 */
export function instantsOf(local: string, timeZone: string) {
  const asUtc = Date.parse(`${local}:00.000Z`);
  const found: string[] = [];
  for (let minutes = -14 * 60; minutes <= 14 * 60; minutes += 15) {
    const candidate = new Date(asUtc - minutes * 60_000);
    if (parts(candidate, timeZone) === local)
      found.push(candidate.toISOString());
  }
  return found.sort();
}

/** The local date-time `weeks` weeks later, same wall-clock time. */
export function addWeeks(local: string, weeks: number) {
  const [date, time] = local.split("T") as [string, string];
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + weeks * 7);
  return `${day.toISOString().slice(0, 10)}T${time}`;
}

/** "dimanche 25 octobre", "jeudi 1er octobre". */
export function dayOf(local: string) {
  const text = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${local.slice(0, 10)}T12:00:00.000Z`));
  return text.replace(/ 1 /, " 1er ");
}

/** "02:30" as shown in `timeZone`, with its UTC offset ("UTC+2"). */
export function clockOf(iso: string, timeZone: string) {
  const time = localOf(iso, timeZone).slice(11);
  const offset =
    new Intl.DateTimeFormat("fr-FR", { timeZone, timeZoneName: "short" })
      .formatToParts(new Date(iso))
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  return { time, offset };
}

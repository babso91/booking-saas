// Labels for the repeated autumn hour. `first` is the occurrence before the
// clocks go back (summer / daylight time), `second` the one after (winter /
// standard time), in both hemispheres.

export type Occurrence = "first" | "second";

function offsetAt(instant: number, timeZone: string) {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(new Date(instant))
    .find((item) => item.type === "timeZoneName")?.value;

  if (!part || part === "GMT") return "UTC";
  return part.replace("GMT", "UTC");
}

/**
 * UTC offsets in force before and after the transition of `date`. Sampled a
 * day either side at noon UTC, far from any transition hour, so no local
 * time conversion is needed.
 */
export function transitionOffsets(date: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const noon = Date.UTC(year!, month! - 1, day!, 12);
  return {
    before: offsetAt(noon - 86_400_000, timeZone),
    after: offsetAt(noon + 86_400_000, timeZone),
  };
}

/** "heure d'été (UTC+2)" / "heure d'hiver (UTC+1)". */
export function occurrenceLabel(
  occurrence: Occurrence,
  date: string,
  timeZone: string,
) {
  const { before, after } = transitionOffsets(date, timeZone);
  return occurrence === "first"
    ? `heure d’été (${before})`
    : `heure d’hiver (${after})`;
}

/** Time with its occurrence when it is ambiguous: "02:30 (heure d'été, UTC+2)". */
export function timeWithOccurrence(
  time: string,
  occurrence: Occurrence | null,
  date: string,
  timeZone: string,
) {
  if (!occurrence) return time;
  const { before, after } = transitionOffsets(date, timeZone);
  return occurrence === "first"
    ? `${time} (heure d’été, ${before})`
    : `${time} (heure d’hiver, ${after})`;
}

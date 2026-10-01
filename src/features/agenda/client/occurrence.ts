import { dayOffsets, type Zone } from "./zone";

// Labels for the repeated autumn hour. `first` is the occurrence before the
// clocks go back (summer / daylight time), `second` the one after (winter /
// standard time), in both hemispheres. The UTC offsets shown come from the
// zone the server read from PostgreSQL; a day it did not send is labelled
// without offsets rather than with the browser's own time zone rules.

export type Occurrence = "first" | "second";

/** "heure d'été (UTC+2)" / "heure d'hiver (UTC+1)". */
export function occurrenceLabel(
  occurrence: Occurrence,
  date: string,
  zone: Zone | null,
) {
  const offsets = dayOffsets(zone, date);
  if (occurrence === "first") {
    return offsets ? `heure d’été (${offsets.before})` : "heure d’été";
  }
  return offsets ? `heure d’hiver (${offsets.after})` : "heure d’hiver";
}

/** Time with its occurrence when it is ambiguous: "02:30 (heure d'été, UTC+2)". */
export function timeWithOccurrence(
  time: string,
  occurrence: Occurrence | null,
  date: string,
  zone: Zone | null,
) {
  if (!occurrence) return time;
  const offsets = dayOffsets(zone, date);
  const season = occurrence === "first" ? "heure d’été" : "heure d’hiver";
  const offset = offsets
    ? occurrence === "first"
      ? offsets.before
      : offsets.after
    : null;
  return offset ? `${time} (${season}, ${offset})` : `${time} (${season})`;
}

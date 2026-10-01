// Civil calendar arithmetic on `YYYY-MM-DD` values: no time zone, no
// instant, so no tzdata involved (safe in Node and the browser).

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function localDateAsUtcMidnight(localDate: string) {
  const match = LOCAL_DATE.exec(localDate);

  if (!match) {
    throw new RangeError(`Invalid local date: ${localDate}`);
  }

  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** `localDate` shifted by `days` calendar days (DST never matters here). */
export function addDaysToLocalDate(localDate: string, days: number) {
  return new Date(localDateAsUtcMidnight(localDate) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Calendar days from `from` to `to` (0 when equal, negative if `to` < `from`). */
export function daysBetweenLocalDates(from: string, to: string) {
  return Math.round(
    (localDateAsUtcMidnight(to) - localDateAsUtcMidnight(from)) / 86_400_000,
  );
}

/** 0 = Sunday … 6 = Saturday, as business_hours.weekday and `extract(dow)`. */
export function weekdayOfLocalDate(localDate: string) {
  return new Date(localDateAsUtcMidnight(localDate)).getUTCDay();
}

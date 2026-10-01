import "server-only";

import { AppException } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Calendar facts of a business, read from PostgreSQL (public.business_time).
//
// PostgreSQL is the only calendar authority: every conversion with a
// consequence on the schedule (civil date ↔ instant, day bounds, opening
// ranges, wall clock and DST occurrence of a stored instant, resolution of a
// typed wall-clock time) comes from the database, with its time zone rules.
// Node's own IANA database (Intl) is never used for them: it can differ from
// the database's (CI: Node 24 reads America/Vancouver as UTC−7 on 2027-03-14,
// PostgreSQL as UTC−8), and the agenda would then disagree with the public
// availability and the booking. Contract: docs/ARCHITECTURE.md §8.

export type LocalTimeOccurrence = "first" | "second";

export type ZoneOffsetDto = {
  /** [startsAt, endsAt): UTC instants with a constant offset. */
  startsAt: string;
  endsAt: string;
  /** Local − UTC, in seconds. */
  offsetSeconds: number;
};

export type OpenRangeDto = {
  startsAt: string;
  endsAt: string;
  localStartsAt: string;
  localEndsAt: string;
};

export type BusinessDayDto = {
  /** Civil date `YYYY-MM-DD`. */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Real bounds of the day: [startsAt, endsAt). Equal on a skipped date. */
  startsAt: string;
  endsAt: string;
};

export type ResolvedLocalTime =
  | { status: "exact"; instant: Date; bound: Date }
  /** Repeated hour: `first` is the earlier instant (before the change). */
  | { status: "ambiguous"; first: Date; second: Date; bound: Date }
  /** Skipped by a forward change; `bound` follows PostgreSQL's rule. */
  | { status: "nonexistent"; bound: Date };

export type WallClock = {
  /** `YYYY-MM-DDTHH:MM` in the business time zone. */
  local: string;
  occurrence: LocalTimeOccurrence | null;
};

export type BusinessTodayDto = {
  /** The business's civil date now, `YYYY-MM-DD`. */
  date: string;
  /** Instant at which that date ends (the next civil date begins). */
  endsAt: string;
};

type RawDay = BusinessDayDto & { openRanges: OpenRangeDto[] | null };

type RawBusinessTime = {
  timezone: string;
  today: string;
  days: RawDay[];
  locals: {
    local: string;
    status: "exact" | "ambiguous" | "nonexistent";
    first: string | null;
    second: string | null;
    bound: string;
  }[];
  instants: { at: string; local: string; occurrence: string | null }[];
  offsets: ZoneOffsetDto[];
};

const iso = (value: string | Date) => new Date(value).toISOString();

function missing(what: string): AppException {
  return new AppException("internal", {
    cause: new Error(`business_time did not return ${what}`),
  });
}

export class BusinessTime {
  readonly timezone: string;
  /** The business's civil date now. */
  readonly today: string;
  /** UTC offset pieces covering the requested days. */
  readonly offsets: ZoneOffsetDto[];
  private readonly dayMap: Map<string, RawDay>;
  private readonly localMap: Map<string, ResolvedLocalTime>;
  private readonly wallMap: Map<string, WallClock>;

  constructor(raw: RawBusinessTime) {
    this.timezone = raw.timezone;
    this.today = raw.today;
    this.offsets = raw.offsets.map((piece) => ({
      startsAt: iso(piece.startsAt),
      endsAt: iso(piece.endsAt),
      offsetSeconds: piece.offsetSeconds,
    }));
    this.dayMap = new Map(
      raw.days.map((day) => [
        day.date,
        {
          ...day,
          startsAt: iso(day.startsAt),
          endsAt: iso(day.endsAt),
          openRanges:
            day.openRanges?.map((range) => ({
              ...range,
              startsAt: iso(range.startsAt),
              endsAt: iso(range.endsAt),
            })) ?? null,
        },
      ]),
    );
    this.localMap = new Map(
      raw.locals.map((entry) => {
        const bound = new Date(entry.bound);
        const resolved: ResolvedLocalTime =
          entry.status === "ambiguous"
            ? {
                status: "ambiguous",
                first: new Date(entry.first!),
                second: new Date(entry.second!),
                bound,
              }
            : entry.status === "exact"
              ? { status: "exact", instant: new Date(entry.first!), bound }
              : { status: "nonexistent", bound };
        return [entry.local, resolved];
      }),
    );
    this.wallMap = new Map(
      raw.instants.map((entry) => [
        iso(entry.at),
        {
          local: entry.local,
          occurrence: entry.occurrence as LocalTimeOccurrence | null,
        },
      ]),
    );
  }

  /** Real bounds of a requested civil date. */
  day(date: string): BusinessDayDto {
    const day = this.dayMap.get(date);
    if (!day) throw missing(`day ${date}`);
    return {
      date: day.date,
      weekday: day.weekday,
      startsAt: day.startsAt,
      endsAt: day.endsAt,
    };
  }

  /** Opening ranges of a requested civil date (requested with openRanges). */
  openRanges(date: string): OpenRangeDto[] {
    const ranges = this.dayMap.get(date)?.openRanges;
    if (!ranges) throw missing(`opening ranges of ${date}`);
    return ranges;
  }

  /** Every instant a requested wall-clock time `YYYY-MM-DDTHH:MM` denotes. */
  local(value: string): ResolvedLocalTime {
    const resolved = this.localMap.get(value);
    if (!resolved) throw missing(`local time ${value}`);
    return resolved;
  }

  /** Wall clock and occurrence of a requested instant. */
  wall(instant: string | Date): WallClock {
    const wall = this.wallMap.get(iso(instant));
    if (!wall) throw missing(`wall clock of ${iso(instant)}`);
    return wall;
  }
}

export type BusinessTimeRequest = {
  /** Civil dates `YYYY-MM-DD` (at most 62). */
  dates?: string[];
  /** With `dates`: also read the real opening ranges of each date. */
  openRanges?: boolean;
  /** Wall-clock times `YYYY-MM-DDTHH:MM` to resolve (at most 16). */
  locals?: string[];
  /** Instants whose wall clock is needed (at most 4000). */
  instants?: (string | Date)[];
};

/** One round trip to the calendar authority (members only). */
export async function readBusinessTime(
  client: AppSupabaseClient,
  businessId: string,
  request: BusinessTimeRequest = {},
): Promise<BusinessTime> {
  const { data, error } = await client.rpc("business_time", {
    p_business_id: businessId,
    p_dates: request.dates ?? [],
    p_locals: request.locals ?? [],
    p_instants: [...new Set((request.instants ?? []).map(iso))],
    p_open_ranges: request.openRanges ?? false,
  });

  if (error) throw databaseException(error);

  return new BusinessTime(data as unknown as RawBusinessTime);
}

/**
 * The business's civil date now and the instant it ends, both from the
 * calendar authority. A screen left open keeps the date until that instant,
 * then asks again: it never works the next date out by itself.
 */
export async function readBusinessToday(
  client: AppSupabaseClient,
  businessId: string,
): Promise<BusinessTodayDto> {
  let { today } = await readBusinessTime(client, businessId);

  // The date can change between the two reads (midnight): read again until
  // the bounds returned are those of the date PostgreSQL calls today.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const calendar = await readBusinessTime(client, businessId, {
      dates: [today],
    });
    if (calendar.today === today) {
      return { date: today, endsAt: calendar.day(today).endsAt };
    }
    today = calendar.today;
  }

  throw missing("a stable date for today");
}

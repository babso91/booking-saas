import type { PublicBookingDto } from "@/features/appointments/data/public-booking";
import type { SlotDto } from "@/features/availability/data/slots";
import type {
  PublicBusinessDto,
  PublicServiceDto,
} from "@/features/businesses/data/public-business";
import type { AppErrorCode } from "@/lib/errors";

// The public booking routes (docs/PUBLIC_BOOKING_CONTRACT.md), called from
// the browser. Never throws: every outcome is a result. `network` means the
// request never got a readable answer (offline, timeout, cut connection):
// for a booking that is ambiguous, the booking may exist.

export type PublicBusiness = PublicBusinessDto;
export type PublicService = PublicServiceDto;
export type Slot = SlotDto;
export type Booking = PublicBookingDto;

export type Availability = { date: string; timezone: string; slots: Slot[] };

export type BookingErrorCode = AppErrorCode | "network";

export type BookingError = {
  code: BookingErrorCode;
  fieldErrors?: Record<string, string[]>;
};

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; error: BookingError };

/** The booking body, as POST /api/bookings expects it. */
export type BookingCommand = {
  slug: string;
  serviceId: string;
  startsAt: string;
  firstName: string;
  lastName?: string;
  email: string;
  phone?: string;
};

/** Longest wait for a read, then for a booking, before saying so. */
export const READ_TIMEOUT_MS = 15_000;
export const BOOKING_TIMEOUT_MS = 20_000;

async function request<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const outer = init.signal;
  const abort = () => controller.abort();
  outer?.addEventListener("abort", abort);
  const timer = setTimeout(abort, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch {
      return { ok: false, error: { code: "network" } };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // Cut while reading, or not our JSON (proxy page): no usable answer.
      return { ok: false, error: { code: "network" } };
    }
    const payload = body as {
      data?: T;
      error?: { code?: unknown; fieldErrors?: Record<string, string[]> };
    } | null;
    if (response.ok && payload?.data !== undefined) {
      return { ok: true, data: payload.data };
    }
    const code = payload?.error?.code;
    return {
      ok: false,
      error: {
        code: typeof code === "string" ? (code as AppErrorCode) : "internal",
        ...(payload?.error?.fieldErrors
          ? { fieldErrors: payload.error.fieldErrors }
          : {}),
      },
    };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
  }
}

const businessUrl = (slug: string) =>
  `/api/public/businesses/${encodeURIComponent(slug)}`;

/** The public profile and its active services (nothing private). */
export function fetchPublicBusiness(slug: string) {
  return request<{ business: PublicBusiness; services: PublicService[] }>(
    businessUrl(slug),
    { method: "GET" },
    READ_TIMEOUT_MS,
  );
}

/** Real slots of one civil day, in the business time zone. */
export function fetchAvailability(
  slug: string,
  serviceId: string,
  date: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ serviceId, date });
  return request<Availability>(
    `${businessUrl(slug)}/availability?${query}`,
    { method: "GET", signal },
    READ_TIMEOUT_MS,
  );
}

/** One booking: idempotent by `requestId` (same id + same body = replay). */
export function postBooking(command: BookingCommand, requestId: string) {
  return request<{ booking: Booking }>(
    "/api/bookings",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...command, requestId }),
    },
    BOOKING_TIMEOUT_MS,
  );
}

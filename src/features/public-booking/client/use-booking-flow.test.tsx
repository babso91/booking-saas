// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicBusiness, PublicService } from "./api";
import { businessToday } from "./business-time";
import { useBookingFlow } from "./use-booking-flow";

// The booking rules without any presentation: what a future visual universe
// would consume. Only fetch is replaced.

const business = {
  slug: "studio-mila",
  name: "Studio Mila",
  timezone: "Europe/Paris",
  maximumBookingAdvanceDays: 14,
} as PublicBusiness;
const service = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "Pose",
  description: null,
  durationMinutes: 60,
  priceCents: 5000,
  currency: "EUR",
} as PublicService;
const today = businessToday(business.timezone);
const slot = {
  startsAt: `${today}T08:00:00.000Z`,
  endsAt: `${today}T09:00:00.000Z`,
  localStartsAt: `${today}T10:00`,
  localEndsAt: `${today}T11:00`,
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

let answerBooking: (response: Response) => void = () => {};
const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const url = String(input);
  if (url === "/api/bookings")
    return new Promise<Response>((done) => (answerBooking = done));
  return Promise.resolve(
    respond({
      data: { date: today, timezone: business.timezone, slots: [slot] },
    }),
  );
});

beforeEach(() => {
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

async function reviewed() {
  const hook = renderHook(() =>
    useBookingFlow({ business, services: [service] }),
  );
  await act(async () => hook.result.current.actions.chooseService(service.id));
  act(() => hook.result.current.actions.chooseSlot(slot));
  act(() => hook.result.current.actions.changeContact("firstName", "Inès"));
  act(() => hook.result.current.actions.changeContact("email", "i@exemple.fr"));
  act(() => {
    hook.result.current.actions.submitContact();
  });
  expect(hook.result.current.step).toBe("review");
  return hook;
}

const bookingCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url) === "/api/bookings");

describe("useBookingFlow (presentation-independent)", () => {
  it("one booking request, even when confirm is called twice in the same tick", async () => {
    const { result } = await reviewed();
    act(() => {
      result.current.actions.confirm();
      result.current.actions.confirm();
      result.current.actions.resendPending();
    });
    expect(bookingCalls()).toHaveLength(1);
    await act(async () =>
      answerBooking(
        respond(
          {
            data: {
              booking: {
                appointmentId: "a",
                startsAt: slot.startsAt,
                endsAt: slot.endsAt,
                timezone: business.timezone,
                serviceName: "Pose",
                durationMinutes: 60,
                priceCents: 5000,
                currency: "EUR",
                businessName: "Studio Mila",
                status: "confirmed",
                replayed: false,
              },
            },
          },
          201,
        ),
      ),
    );
    expect(result.current.step).toBe("done");
    expect(result.current.bookedLocal).toBe(slot.localStartsAt);
  });

  it("nothing can be changed while the booking is being sent", async () => {
    const { result } = await reviewed();
    act(() => result.current.actions.confirm());
    act(() => {
      result.current.actions.changeContact("firstName", "Autre");
      result.current.actions.goTo("slot");
      result.current.actions.chooseService(service.id);
    });
    expect(result.current.contact.firstName).toBe("Inès");
    expect(result.current.step).toBe("review");
    expect(result.current.isSending).toBe(true);
  });
});

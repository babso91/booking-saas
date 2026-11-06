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
      data: {
        date: today,
        timezone: business.timezone,
        slots: [slot],
        quote: {
          serviceName: service.name,
          durationMinutes: service.durationMinutes,
          priceCents: service.priceCents,
          currency: "EUR",
          options: [],
        },
      },
    }),
  );
});

beforeEach(() => {
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

async function reviewed() {
  const hook = renderHook(() =>
    useBookingFlow({
      business,
      catalog: {
        currency: "EUR",
        groups: [
          {
            category: null,
            services: [{ ...service, options: [] }],
          },
        ],
      },
    }),
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

describe("late answers never replace the quote of her current choice (Codex audit)", () => {
  const withOptions = {
    id: "30000000-0000-4000-8000-0000000000aa",
    name: "Henné",
    description: null,
    durationMinutes: 45,
    priceCents: 3000,
    options: [
      {
        id: "40000000-0000-4000-8000-000000000001",
        question: "Taille",
        required: true,
        choices: [
          {
            id: "50000000-0000-4000-8000-000000000001",
            label: "Fin",
            priceDeltaCents: 0,
            durationDeltaMinutes: 0,
          },
        ],
      },
    ],
  };
  const catalog = {
    currency: "EUR",
    groups: [
      {
        category: null,
        services: [withOptions, { ...service, options: [] }],
      },
    ],
  };

  it("the catalogue read again for A, answered after she chose B, changes nothing of B", async () => {
    let answerCatalog: (response: Response) => void = () => {};
    const availabilityFor: string[] = [];
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/availability")) {
        const id = new URL(url, "http://x").searchParams.get("serviceId")!;
        availabilityFor.push(id);
        // A's options changed on the server: its slots are refused.
        if (id === withOptions.id)
          return Promise.resolve(
            respond({ error: { code: "options_required" } }, 422),
          );
        return Promise.resolve(
          respond({
            data: {
              date: today,
              timezone: business.timezone,
              slots: [slot],
              quote: {
                serviceName: service.name,
                durationMinutes: service.durationMinutes,
                priceCents: service.priceCents,
                currency: "EUR",
                options: [],
              },
            },
          }),
        );
      }
      // The catalogue read again for A: held until released.
      return new Promise<Response>((done) => (answerCatalog = done));
    }) as unknown as typeof fetch;

    const hook = renderHook(() => useBookingFlow({ business, catalog }));
    // A: its slots are refused, its catalogue is read again (held).
    await act(async () =>
      hook.result.current.actions.chooseService(withOptions.id),
    );
    expect(hook.result.current.notice).toBe("options_changed");
    // She leaves A for B before that answer comes back.
    act(() => hook.result.current.actions.goTo("service"));
    await act(async () =>
      hook.result.current.actions.chooseService(service.id),
    );
    expect(hook.result.current.slots).toMatchObject({
      status: "ready",
      quote: { priceCents: 5000 },
    });
    const asked = availabilityFor.length;

    // A's late catalogue arrives.
    await act(async () => {
      answerCatalog(respond({ data: { business, services: [], catalog } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // B stays chosen, with B's quote; nothing was read again for A.
    expect(hook.result.current.service?.id).toBe(service.id);
    expect(hook.result.current.answers).toEqual({});
    expect(hook.result.current.slots).toMatchObject({
      status: "ready",
      quote: { priceCents: 5000, durationMinutes: 60 },
    });
    expect(availabilityFor.slice(asked)).toEqual([]);
  });
});

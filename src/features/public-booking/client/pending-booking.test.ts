// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  clearPendingBooking,
  readPendingBooking,
  writePendingBooking,
} from "./pending-booking";

const request = {
  command: {
    slug: "studio-mila",
    serviceId: "30000000-0000-4000-8000-000000000001",
    startsAt: "2026-10-20T16:30:00.000Z",
    firstName: "Inès",
    email: "ines@exemple.fr",
  },
  key: { fingerprint: "f", id: "50000000-0000-4000-8000-000000000001" },
  localStartsAt: "2026-10-20T09:30",
};

describe("the unconfirmed booking of a page", () => {
  it("is kept per business page, and never read for another one", () => {
    writePendingBooking("studio-mila", request);
    expect(readPendingBooking("studio-mila")).toEqual(request);
    expect(readPendingBooking("atelier-nour")).toBeNull();
    // A value stored under a page but naming another business is ignored.
    window.sessionStorage.setItem(
      "public-booking:atelier-nour",
      JSON.stringify(request),
    );
    expect(readPendingBooking("atelier-nour")).toBeNull();
    clearPendingBooking("studio-mila");
    expect(readPendingBooking("studio-mila")).toBeNull();
  });

  it("ignores anything malformed", () => {
    window.sessionStorage.setItem("public-booking:studio-mila", "{not json");
    expect(readPendingBooking("studio-mila")).toBeNull();
    window.sessionStorage.setItem(
      "public-booking:studio-mila",
      JSON.stringify({ ...request, localStartsAt: "09:30" }),
    );
    expect(readPendingBooking("studio-mila")).toBeNull();
  });
});

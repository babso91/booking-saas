import type { BrowserContext } from "playwright";

// The trusted ingress, played by the tests (src/lib/client-identity.ts): in
// production the reverse proxy writes the client's address and a secret on
// every request, and POST /api/bookings refuses any request without them.
// The e2e server is started with this secret; a customer's browser that
// books online carries what the proxy would have written.

/** BOOKING_PROXY_SECRET of the e2e server (test only, ≥ 32 characters). */
export const E2E_PROXY_SECRET = "e2e-booking-proxy-secret-not-a-real-one-000";

/** A customer behind the proxy, at this documentation address (RFC 5737). */
export async function behindIngress(context: BrowserContext, address: string) {
  await context.setExtraHTTPHeaders({
    "x-booking-proxy-secret": E2E_PROXY_SECRET,
    "x-booking-client-ip": address,
  });
}

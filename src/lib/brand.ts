// Product identity used across the auth and onboarding surfaces. The final
// product name is not decided yet: keep every mention behind this constant.
export const brand = {
  name: "Booking",
  tagline: "L’agenda des indépendantes beauté",
} as const;

// Host shown in booking-link previews ("booking.app/b/studio-mila"). Derived
// from the canonical app URL when available so previews match production.
export function bookingHost(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  if (appUrl) {
    try {
      return new URL(appUrl).host;
    } catch {
      // Fall through to the placeholder host.
    }
  }

  return "booking.app";
}

// Full public URL of a booking page, for copying and sharing.
export function bookingUrl(slug: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  let origin = "https://booking.app";

  if (appUrl) {
    try {
      origin = new URL(appUrl).origin;
    } catch {
      // Keep the placeholder origin.
    }
  }

  return `${origin}/b/${slug}`;
}

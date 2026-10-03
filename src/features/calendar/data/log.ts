import "server-only";

// Structured calendar logs. Only identifiers, operation names and stable
// codes are written: never an access or refresh token, an OAuth code, a
// state, a channel token, nor a provider response body.

type Fields = {
  businessId?: string;
  connectionId?: string;
  calendarId?: string;
  provider?: string;
  status?: string;
  code?: string;
  count?: number;
  /** An IANA zone name as the provider sent it (public, never a secret). */
  timezone?: string;
};

export function logCalendar(
  operation: string,
  fields: Fields,
  level: "info" | "warn" | "error" = "info",
) {
  const line = JSON.stringify({ scope: "calendar", operation, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

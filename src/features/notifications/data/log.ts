import "server-only";

// Structured email logs. Only identifiers, types, statuses and stable codes
// are written: never a recipient, a subject, a body, a provider answer nor
// a credential.

type Fields = {
  emailEventId?: string;
  businessId?: string;
  type?: string;
  transport?: string;
  status?: string;
  code?: string;
  attempt?: number;
  count?: number;
};

export function logEmail(
  operation: string,
  fields: Fields,
  level: "info" | "warn" | "error" = "info",
) {
  const line = JSON.stringify({ scope: "email", operation, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

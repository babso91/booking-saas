const HOME = "/espace";
const UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const APPOINTMENT = new RegExp(
  "^/espace/" + UUID + "/rendez-vous/" + UUID + "$",
  "i",
);

export function hubAppointmentPath(businessId: string, appointmentId: string) {
  return (
    "/espace/" +
    encodeURIComponent(businessId) +
    "/rendez-vous/" +
    encodeURIComponent(appointmentId)
  );
}

/** The two exact same-origin destinations supported after an email check. */
export function safeHubReturnPath(value: unknown): string {
  if (typeof value !== "string" || /[\s\\?%]/.test(value)) return HOME;
  if (value.length <= 71 && /^\/b\/[a-z0-9]+(?:-[a-z0-9]+)*#avis$/.test(value))
    return value;
  return value === HOME || APPOINTMENT.test(value) ? value : HOME;
}

export function hubSignInHref(returnTo?: unknown): string {
  const path = safeHubReturnPath(returnTo);
  return path === HOME
    ? "/espace/connexion"
    : "/espace/connexion?next=" + encodeURIComponent(path);
}

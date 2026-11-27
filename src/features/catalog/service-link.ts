import { slugify } from "@/features/onboarding/slug";

/**
 * A direct link to one of her services (Higani point 29): her public page
 * with `?prestation=<key>` opens its booking at once, as a tap on it would.
 *
 * The key reads like the service ("rehaussement-de-cils-3c9f2a1e"): its name,
 * then the start of its id, so a renamed service keeps its links (a QR code
 * already printed, a story already posted). A key with the name alone (the
 * client hub has no service id) still finds a service whose name is unique.
 */
export const SERVICE_LINK_PARAM = "prestation";

const SHORT_ID = 8;

export function serviceLinkKey(service: { id?: string; name: string }) {
  const name = slugify(service.name).slice(0, 48).replace(/-+$/, "");
  const short = service.id?.slice(0, SHORT_ID).toLowerCase();
  return [name, short].filter(Boolean).join("-");
}

/** Her public page, opened on that service. */
export function serviceLinkPath(
  slug: string,
  service: { id?: string; name: string },
) {
  return `/b/${encodeURIComponent(slug)}?${SERVICE_LINK_PARAM}=${serviceLinkKey(service)}`;
}

/**
 * The service a link names, among those she offers online; none when it
 * is gone, hidden, or the key could name two of them.
 */
export function linkedService<T extends { id: string; name: string }>(
  services: readonly T[],
  key: string | undefined,
): T | undefined {
  const wanted = key?.trim().toLowerCase();
  if (!wanted) return undefined;
  const short = wanted.slice(-SHORT_ID);
  if (/^[0-9a-f]{8}$/.test(short)) {
    const byId = services.filter((service) =>
      service.id.toLowerCase().startsWith(short),
    );
    if (byId.length === 1) return byId[0];
  }
  const byName = services.filter(
    (service) => serviceLinkKey({ name: service.name }) === wanted,
  );
  return byName.length === 1 ? byName[0] : undefined;
}

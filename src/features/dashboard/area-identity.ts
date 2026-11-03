import type { PreferenceContext } from "@/features/preferences/model";

/**
 * Whose area is on screen: her membership of a business, as the server
 * session of this very render resolved it (requireReadyBusiness), never the
 * client. Leaving and joining again is another membership, so another area.
 *
 * Everything the area holds on the client — the agenda read, its services,
 * open panels and forms, unfolded notes, answers still on their way — belongs
 * to one identity and is dropped when it changes (AppShell). The same
 * identity as her preferences' (PreferenceContext).
 */
export type AreaIdentity = PreferenceContext;

/** From the ready session state the page's guard returned. */
export function areaIdentityOf(session: {
  user: { id: string };
  business: { id: string; membershipId: string };
}): AreaIdentity {
  return {
    userId: session.user.id,
    businessId: session.business.id,
    membershipId: session.business.membershipId,
  };
}

/** Two identities are the same area iff their keys are equal. */
export const areaIdentityKey = (identity: AreaIdentity) =>
  `${identity.userId}:${identity.businessId}:${identity.membershipId}`;

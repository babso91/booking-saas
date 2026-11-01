import "server-only";

import { cache } from "react";

import { renderableAppearance } from "@/features/preferences/model";
import { loadAreaPreferences } from "@/features/preferences/server/area-preferences";

import { DELIVERED_STYLES, type Appearance } from "../appearance";

/** One read per request, for the layout and the page that both need it. */
const areaOf = cache((userId: string, businessId: string) =>
  loadAreaPreferences({ userId, businessId }),
);

export const loadArea = (member: { userId: string; businessId: string }) =>
  areaOf(member.userId, member.businessId);

/** What the page draws, without changing what her account holds. */
export async function loadRenderedAppearance(member: {
  userId: string;
  businessId: string;
}): Promise<Appearance> {
  const area = await loadArea(member);
  return renderableAppearance(area.appearance, DELIVERED_STYLES);
}

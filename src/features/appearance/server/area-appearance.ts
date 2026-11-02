import "server-only";

import { cache } from "react";

import { renderableAppearance } from "@/features/preferences/model";
import { loadAreaPreferences } from "@/features/preferences/server/area-preferences";

import { DELIVERED_STYLES, type Appearance } from "../appearance";

/** One read per request, for the layout and the page that both need it. */
export const loadArea = cache(() => loadAreaPreferences());

/** What the page draws, without changing what her account holds. */
export async function loadRenderedAppearance(): Promise<Appearance> {
  const area = await loadArea();
  return renderableAppearance(area.appearance, DELIVERED_STYLES);
}

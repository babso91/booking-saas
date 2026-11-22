import type { ReviewPage } from "@/features/reviews/model";

import type { ShowcaseGroup } from "../catalog/model";
import type { SiteConfig } from "../engine/config";
import type { UsualHours } from "../practical";

// Her studio and its « Comme mes clientes » frame (Higani points 122,
// 123) talk by window messages, same origin only: the studio sends what
// it shows, the frame says when it is ready to receive it.

export const CLIENT_VIEW_PATH = "/app/site/apercu";
export const FRAME_READY = "higani:client-view-ready";
export const FRAME_SHOW = "higani:client-view-show";

export type FrameShow = {
  type: typeof FRAME_SHOW;
  config: SiteConfig;
  catalog: ShowcaseGroup[];
  hours: UsualHours[] | null;
  reviews: ReviewPage | null;
};

/** A message from this same site's window `from`, of this type. */
export function fromOwnWindow(
  event: MessageEvent,
  from: Window | null | undefined,
  type: string,
): boolean {
  return (
    event.origin === window.location.origin &&
    from != null &&
    event.source === from &&
    typeof event.data === "object" &&
    event.data !== null &&
    (event.data as { type?: unknown }).type === type
  );
}

import "server-only";

import { z } from "zod";

import { sha256Hex } from "@/lib/crypto/secret-box";

import type { CalendarDeps } from "./deps";
import { logCalendar } from "./log";

// Provider push notifications (Google: headers only, no body we trust).
// A notification is accepted only if its channel is the current channel of a
// selected calendar of an active connection, with the same resource id and
// token, and not expired; the business is derived from that channel, never
// from the request. Anything else is ignored with the same answer, so the
// endpoint reveals nothing.

const notificationSchema = z.object({
  channelId: z.uuid(),
  resourceId: z.string().min(1).max(512),
  token: z.string().min(1).max(256),
  state: z.enum(["sync", "exists", "not_exists"]),
});

export type NotificationHeaders = {
  get(name: string): string | null;
};

/** The calendar to sync, or null when the notification is ignored. */
export async function verifyNotification(
  deps: CalendarDeps,
  headers: NotificationHeaders,
): Promise<string | null> {
  const parsed = notificationSchema.safeParse({
    channelId: headers.get("x-goog-channel-id"),
    resourceId: headers.get("x-goog-resource-id"),
    token: headers.get("x-goog-channel-token"),
    state: headers.get("x-goog-resource-state"),
  });
  if (!parsed.success) {
    logCalendar("notification_ignored", { code: "malformed" });
    return null;
  }

  const { data, error } = await deps.admin.rpc("calendar_verify_notification", {
    p_channel_id: parsed.data.channelId,
    p_resource_id: parsed.data.resourceId,
    p_token_hash: sha256Hex(parsed.data.token),
  });
  if (error || !data) {
    logCalendar("notification_ignored", {
      code: error ? "error" : "unknown_channel",
    });
    return null;
  }

  // "sync" only confirms the channel's creation: nothing changed yet.
  if (parsed.data.state === "sync") return null;
  return data;
}

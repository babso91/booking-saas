import "server-only";

import { randomUUID } from "node:crypto";

import type {
  CalendarProviderId,
  ProviderChannel,
} from "@/features/calendar/providers/types";
import { randomToken, sha256Hex } from "@/lib/crypto/secret-box";

import type { CalendarDeps } from "./deps";
import { logCalendar } from "./log";
import { withAccessToken } from "./tokens";

// Push channels: the provider calls our webhook when a watched calendar
// changes. A notification only means "something changed, sync": it never
// carries data we trust. Each channel has a random token (only its hash is
// stored); channels expire and are renewed by the periodic job a day before.
// Notifications are best effort (Google drops a few): the periodic job also
// syncs every calendar not synced for 6 hours.

const RENEW_BEFORE_MS = 86_400_000;

type ChannelClaim = {
  calendarId: string;
  connectionId: string;
  businessId: string;
  provider: CalendarProviderId;
  providerCalendarId: string;
  channelId: string | null;
  channelExpiresAt: string | null;
};

/** Stops channels at the provider, best effort (they also expire). */
export async function stopChannels(
  deps: CalendarDeps,
  connectionId: string,
  provider: CalendarProviderId,
  channels: ProviderChannel[],
  accessToken?: string,
) {
  for (const channel of channels) {
    try {
      if (accessToken) {
        await deps.provider(provider).stopChannel(accessToken, channel);
      } else {
        await withAccessToken(deps, connectionId, (token) =>
          deps.provider(provider).stopChannel(token, channel),
        );
      }
    } catch {
      logCalendar("channel_stop_failed", { connectionId, provider }, "warn");
    }
  }
}

/**
 * Creates the calendar's channel when push is configured and none is valid
 * for another day; stops the one it replaces. Never fails the sync.
 */
export async function ensureChannel(deps: CalendarDeps, claim: ChannelClaim) {
  const address = deps.env.GOOGLE_CALENDAR_WEBHOOK_URL;
  if (!address) return;
  if (
    claim.channelId &&
    claim.channelExpiresAt &&
    new Date(claim.channelExpiresAt).getTime() - Date.now() > RENEW_BEFORE_MS
  ) {
    return;
  }

  try {
    const channelId = randomUUID();
    const token = randomToken(32);
    const watched = await withAccessToken(
      deps,
      claim.connectionId,
      (accessToken) =>
        deps
          .provider(claim.provider)
          .watchEvents(accessToken, claim.providerCalendarId, {
            id: channelId,
            token,
            address,
          }),
    );
    const { data, error } = await deps.admin.rpc("calendar_record_channel", {
      p_calendar_id: claim.calendarId,
      p_channel_id: channelId,
      p_resource_id: watched.resourceId,
      p_token_hash: sha256Hex(token),
      p_expires_at: watched.expiresAt.toISOString(),
    });
    if (error) throw error;

    const replaced = data as { channelId: string; resourceId: string } | null;
    if (replaced?.channelId) {
      await stopChannels(deps, claim.connectionId, claim.provider, [
        { id: replaced.channelId, resourceId: replaced.resourceId },
      ]);
    }
    logCalendar("channel_created", {
      calendarId: claim.calendarId,
      connectionId: claim.connectionId,
      provider: claim.provider,
    });
  } catch {
    logCalendar(
      "channel_failed",
      { calendarId: claim.calendarId, connectionId: claim.connectionId },
      "warn",
    );
  }
}

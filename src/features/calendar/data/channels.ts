import "server-only";

import { randomUUID } from "node:crypto";

import type {
  CalendarProviderId,
  ProviderChannel,
} from "@/features/calendar/providers/types";
import { randomToken, sha256Hex } from "@/lib/crypto/secret-box";

import type { CalendarDeps } from "./deps";
import { logCalendar } from "./log";
import type { SyncPass } from "./sync";
import { StaleCredentialsError, withAccessToken } from "./tokens";

// Push channels: the provider calls our webhook when a watched calendar
// changes. A notification only means "something changed, sync": it never
// carries data we trust. Each channel has a random token (only its hash is
// stored); channels expire and are renewed by the periodic job a day before.
// Notifications are best effort (Google drops a few): the periodic job also
// syncs every calendar not synced for 6 hours.

const RENEW_BEFORE_MS = 86_400_000;

/** Stops channels at the provider, best effort (they also expire). */
export async function stopChannels(
  deps: CalendarDeps,
  connectionId: string,
  provider: CalendarProviderId,
  channels: ProviderChannel[],
  options: {
    accessToken?: string;
    generation?: string;
    deadline?: number;
  } = {},
) {
  for (const channel of channels) {
    try {
      if (options.accessToken) {
        await deps
          .provider(provider)
          .stopChannel(options.accessToken, channel, {
            deadline: options.deadline,
          });
      } else {
        await withAccessToken(
          deps,
          connectionId,
          (token) =>
            deps
              .provider(provider)
              .stopChannel(token, channel, { deadline: options.deadline }),
          { generation: options.generation, deadline: options.deadline },
        );
      }
    } catch {
      logCalendar("channel_stop_failed", { connectionId, provider }, "warn");
    }
  }
}

export type ChannelResult = {
  /**
   * unchanged: push not configured or channel valid for another day;
   * recorded: a new channel is current (`replaced` is the former one, still
   * running: the caller catches up, then stops it); superseded: the claim
   * was lost (the new channel was stopped); failed: no new channel (the
   * sync itself is unaffected).
   */
  status: "unchanged" | "recorded" | "superseded" | "failed";
  replaced: ProviderChannel | null;
};

/** Creates the calendar's channel when push is configured and none is valid. */
export async function ensureChannel(pass: SyncPass): Promise<ChannelResult> {
  const { deps, claim } = pass;
  const address = deps.env.GOOGLE_CALENDAR_WEBHOOK_URL;
  if (!address) return { status: "unchanged", replaced: null };
  if (
    claim.channelId &&
    claim.channelExpiresAt &&
    new Date(claim.channelExpiresAt).getTime() - Date.now() > RENEW_BEFORE_MS
  ) {
    return { status: "unchanged", replaced: null };
  }

  const provider = deps.provider(claim.provider);
  const channelId = randomUUID();
  const token = randomToken(32);
  // The access token that created the channel, kept in memory only: if the
  // channel cannot be recorded (claim lost, reconnection), it is stopped
  // with the very credentials that created it, which may no longer exist
  // in the database.
  let watchToken: string | undefined;
  let watched;
  try {
    watched = await withAccessToken(
      deps,
      claim.connectionId,
      (accessToken) => {
        watchToken = accessToken;
        return provider.watchEvents(
          accessToken,
          claim.providerCalendarId,
          { id: channelId, token, address },
          { deadline: pass.deadline },
        );
      },
      { generation: claim.connectionGeneration, deadline: pass.deadline },
    );
  } catch (error) {
    if (error instanceof StaleCredentialsError) {
      return { status: "superseded", replaced: null };
    }
    logCalendar(
      "channel_failed",
      { calendarId: claim.calendarId, connectionId: claim.connectionId },
      "warn",
    );
    return { status: "failed", replaced: null };
  }

  const created = { id: channelId, resourceId: watched.resourceId };
  const { data, error } = await deps.admin.rpc("calendar_record_channel", {
    p_calendar_id: claim.calendarId,
    p_claim_id: claim.claimId,
    p_channel_id: channelId,
    p_resource_id: watched.resourceId,
    p_token_hash: sha256Hex(token),
    p_expires_at: watched.expiresAt.toISOString(),
  });
  const recorded = data as {
    channelId: string;
    resourceId: string;
    orphan?: boolean;
  } | null;

  if (error || recorded?.orphan) {
    // Not recorded (the claim was lost, or the database failed): nobody
    // would ever stop this channel.
    await stopChannels(deps, claim.connectionId, claim.provider, [created], {
      accessToken: watchToken,
      deadline: pass.deadline + 5_000,
    });
    if (error) {
      logCalendar(
        "channel_failed",
        { calendarId: claim.calendarId, connectionId: claim.connectionId },
        "warn",
      );
      return { status: "failed", replaced: null };
    }
    return { status: "superseded", replaced: null };
  }

  logCalendar("channel_created", {
    calendarId: claim.calendarId,
    connectionId: claim.connectionId,
    provider: claim.provider,
  });
  return {
    status: "recorded",
    replaced: recorded?.channelId
      ? { id: recorded.channelId, resourceId: recorded.resourceId }
      : null,
  };
}

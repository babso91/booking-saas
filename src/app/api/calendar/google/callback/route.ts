import type { NextRequest } from "next/server";

import { runAfterResponse } from "@/features/calendar/data/background";
import { completeConnect } from "@/features/calendar/data/connection";
import { getCalendarDeps } from "@/features/calendar/data/deps";
import { logCalendar } from "@/features/calendar/data/log";
import { syncCalendar } from "@/features/calendar/data/sync";
import { getBusinessContext } from "@/features/businesses/data/business-context";
import { sha256Hex } from "@/lib/crypto/secret-box";
import { AppException } from "@/lib/errors";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// GET /api/calendar/google/callback?state=…&code=… (or &error=access_denied)
// OAuth redirect from Google. Server only: the code is exchanged here, tokens
// never reach the browser or a URL. Always answers with a redirect to a fixed
// path of the app carrying a result code (never an open redirect).

export const dynamic = "force-dynamic";

type Result =
  | "connected"
  | "denied"
  | "invalid_state"
  | "scope_missing"
  | "provider_unavailable"
  | "not_configured"
  | "error";

function back(request: NextRequest, result: Result, path = "/app") {
  const url = new URL(path, request.nextUrl.origin);
  url.searchParams.set("calendar", result);
  return Response.redirect(url, 303);
}

function resultOf(error: unknown): Result {
  if (!(error instanceof AppException)) return "error";
  switch (error.code) {
    case "oauth_state_invalid":
      return "invalid_state";
    case "calendar_scope_missing":
      return "scope_missing";
    case "calendar_provider_unavailable":
    case "calendar_reauth_required":
      return "provider_unavailable";
    case "calendar_not_configured":
      return "not_configured";
    default:
      return "error";
  }
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  const code = params.get("code");
  const providerError = params.get("error");

  try {
    const client = await createServerSupabaseClient();
    let business;
    try {
      business = await getBusinessContext(client);
    } catch (error) {
      if (error instanceof AppException && error.code === "unauthenticated") {
        return back(request, "invalid_state", "/login");
      }
      throw error;
    }
    const deps = getCalendarDeps();
    const context = {
      client,
      userId: business.userId,
      businessId: business.businessId,
    };

    if (!state || state.length > 200) return back(request, "invalid_state");

    if (providerError || !code) {
      // Denied (or no code): the state is consumed so it cannot be replayed.
      await client.rpc("calendar_consume_oauth_state", {
        p_state_hash: sha256Hex(state),
      });
      return back(
        request,
        providerError === "access_denied" ? "denied" : "error",
      );
    }

    const { connectionId } = await completeConnect(context, deps, {
      state,
      code,
    });

    // Reconnection: calendars already selected sync again, after the response.
    runAfterResponse("reconnect_sync", async () => {
      const { data } = await deps.admin
        .from("external_calendars")
        .select("id")
        .eq("connection_id", connectionId)
        .eq("selected_for_blocking", true);
      for (const calendar of data ?? []) await syncCalendar(deps, calendar.id);
    });

    return back(request, "connected");
  } catch (error) {
    const result = resultOf(error);
    logCalendar(
      "connect_failed",
      { code: result },
      result === "error" ? "error" : "warn",
    );
    return back(request, result);
  }
}

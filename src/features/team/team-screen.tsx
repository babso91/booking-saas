"use client";

import { useMemo } from "react";

import {
  createStaffAction,
  readTeamAction,
  revokeAccessAction,
  sendInviteAction,
  updateStaffAction,
} from "./actions/team";
import type { TeamActions, TeamResult } from "./contract";
import { TeamManager } from "./team-manager";

/**
 * A server action that throws (connection lost, server down) answers as a
 * network failure: the screen keeps the same operation id for its retry.
 */
async function safely<T>(
  run: () => Promise<TeamResult<T>>,
): Promise<TeamResult<T>> {
  try {
    return await run();
  } catch {
    return { ok: false, error: { code: "network" } };
  }
}

/** Her team, on the real server actions (docs/TEAM_CONTRACT.md). */
export function TeamScreen() {
  const actions = useMemo<TeamActions>(
    () => ({
      read: () => safely(() => readTeamAction()),
      createStaff: (input) => safely(() => createStaffAction(input)),
      updateStaff: (input) => safely(() => updateStaffAction(input)),
      sendInvite: (input) => safely(() => sendInviteAction(input)),
      revokeAccess: (input) => safely(() => revokeAccessAction(input)),
    }),
    [],
  );
  // No email transport is validated yet: no invitation is offered
  // (docs/TEAM_CONTRACT.md, « Invitation »).
  return <TeamManager actions={actions} invitations="not_sent_yet" />;
}

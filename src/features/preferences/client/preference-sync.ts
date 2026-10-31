import {
  changesBetween,
  type AppearanceChanges,
  type AppearancePreferences,
  type MemberPreferences,
} from "../model";

// How a device keeps her preferences in step with her account, as a pure
// state machine (the provider of the appearance engine drives it; tested in
// preference-sync.test.ts). The account decides; the device shows her
// choices at once and sends them.
//
//   confirmed  the latest account state this device has seen (version);
//              never replaced by an older one: answers that arrive late, or
//              out of order, cannot bring an old appearance back.
//   inFlight   the save being sent, if any: one at a time, so that two of
//              her saves never race each other.
//   pending    what she changed here since, field by field (her latest
//              choice per field), relative to confirmed + inFlight.
//
// What she sees is confirmed + inFlight + pending. A save is a patch, based
// on confirmed.version. The answer:
//   saved / unchanged  what was sent is the account's (even if another
//                      device has changed it since); pending is sent next;
//   stale              another device saved first, nothing was written:
//                      what was sent goes back to pending and is sent again
//                      on the account's version (her latest choice wins
//                      over an older one, field by field);
//   failed             (network, database away) the same, without a new
//                      version; sent again later.

export type SaveRequest = {
  expectedVersion: number;
  changes: AppearanceChanges;
};

export type SyncState = {
  confirmed: MemberPreferences;
  inFlight: SaveRequest | null;
  pending: AppearanceChanges;
};

export type SaveAnswer = {
  status: "saved" | "unchanged" | "stale";
  preferences: MemberPreferences;
};

export function initialSyncState(confirmed: MemberPreferences): SyncState {
  return { confirmed, inFlight: null, pending: {} };
}

/** What the area shows: the account's state with her unconfirmed choices. */
export function displayedAppearance(state: SyncState): AppearancePreferences {
  return { ...base(state.confirmed, state.inFlight), ...state.pending };
}

/** She changed something here (shown at once, sent by nextSave). */
export function changeLocally(
  state: SyncState,
  next: AppearancePreferences,
): SyncState {
  return {
    ...state,
    pending: changesBetween(base(state.confirmed, state.inFlight), next),
  };
}

/** The save to send now, if any (none while another is in flight). */
export function nextSave(state: SyncState): [SyncState, SaveRequest | null] {
  if (state.inFlight || Object.keys(state.pending).length === 0) {
    return [state, null];
  }
  const request = {
    expectedVersion: state.confirmed.version,
    changes: state.pending,
  };
  return [{ ...state, inFlight: request, pending: {} }, request];
}

/** The answer to the save in flight. */
export function saveAnswered(state: SyncState, answer: SaveAnswer): SyncState {
  const confirmed = newer(state.confirmed, answer.preferences);
  const pending =
    answer.status === "stale" && state.inFlight
      ? { ...state.inFlight.changes, ...state.pending }
      : state.pending;
  return settle(confirmed, null, pending);
}

/** The save in flight got no answer (network, database away). */
export function saveFailed(state: SyncState): SyncState {
  if (!state.inFlight) return state;
  return settle(state.confirmed, null, {
    ...state.inFlight.changes,
    ...state.pending,
  });
}

/**
 * The account's state as read (focus, a new render of the area, another
 * tab): adopted if it is newer than what this device has seen.
 */
export function accountRead(
  state: SyncState,
  read: MemberPreferences,
): SyncState {
  return settle(newer(state.confirmed, read), state.inFlight, state.pending);
}

/**
 * She signed in as someone else, or in another business: nothing of the
 * previous account is kept, not even unsent choices.
 */
export function accountChanged(confirmed: MemberPreferences): SyncState {
  return initialSyncState(confirmed);
}

function base(confirmed: MemberPreferences, inFlight: SaveRequest | null) {
  return { ...confirmed.appearance, ...inFlight?.changes };
}

function newer(current: MemberPreferences, candidate: MemberPreferences) {
  return candidate.version > current.version ? candidate : current;
}

/** Pending reduced to what confirmed + inFlight does not already have. */
function settle(
  confirmed: MemberPreferences,
  inFlight: SaveRequest | null,
  pending: AppearanceChanges,
): SyncState {
  const from = base(confirmed, inFlight);
  return {
    confirmed,
    inFlight,
    pending: changesBetween(from, { ...from, ...pending }),
  };
}

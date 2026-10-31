import {
  changesBetween,
  sameContext,
  type AppearanceChanges,
  type AppearancePreferences,
  type MemberPreferences,
  type PreferenceContext,
  type PreferencesSnapshot,
} from "../model";

// How a device keeps her preferences in step with her account, as a pure
// state machine (the appearance engine's provider drives it; tested in
// preference-sync.test.ts). The account decides; the device shows her
// choices at once and sends them.
//
// Isolation. Every answer is matched against three things, and ignored
// entirely (data, completion, failure) if one does not match:
//   * the generation: a number the device gives each context it enters.
//     Entering a context (another account, another business, the same one
//     again after leaving it, a new sign-in) starts a new generation;
//     answers to requests of an earlier generation are dropped, whatever
//     their content or version;
//   * the context the server answered for (her membership): an answer for
//     another one means the session changed under this page; nothing of it
//     is taken, and saving stops until the page enters the new context;
//   * the request: a save's answer or failure ends that save only (its
//     ticket), never a later one.
//
// Freshness, within a context. The account's state is (incarnation,
// version). Within one incarnation, the higher version is the newer. Across
// incarnations (the row was deleted and created again, or does not exist
// any more), versions mean nothing: the answer to the request sent last is
// the newer. An older state never replaces a newer one.
//
// What she sees is confirmed + inFlight + pending. A save is a patch of
// her changes, based on the confirmed state. Its answer:
//   saved / unchanged  what was sent is the account's; pending goes next;
//   stale              nothing was written: what was sent goes back to
//                      pending, sent again on the state the answer brought;
//   failed (network)   the same, sent again later (the driver waits).
// After STALE_LIMIT stale answers in a row, saving pauses ("conflict")
// until a read brings the account's state again: never an endless loop.
// A refusal for the context (signed out, another session, or the session
// unreadable while the database is away: the server cannot tell) pauses it
// too; a read answered for this same context resumes it, so nothing she
// chose is lost once the account answers again.

export const STALE_LIMIT = 5;

/** Identifies a request: its context's generation, and its order. */
export type Ticket = { generation: number; seq: number };

export type SaveRequest = {
  ticket: Ticket;
  context: PreferenceContext;
  expected: Pick<MemberPreferences, "incarnation" | "version">;
  changes: AppearanceChanges;
};

export type SaveAnswer = PreferencesSnapshot & {
  status: "saved" | "unchanged" | "stale";
};

export type SyncState = {
  context: PreferenceContext;
  generation: number;
  confirmed: MemberPreferences;
  /** The request whose answer brought `confirmed` (0: the page's render). */
  confirmedSeq: number;
  nextSeq: number;
  inFlight: SaveRequest | null;
  pending: AppearanceChanges;
  staleStreak: number;
  /**
   * context_changed: the session is not, or could not be shown to be, this
   * context's (another account, business or membership, signed out, or the
   * database away); conflict: too many stale answers. Nothing is sent while
   * paused; a read answered for this context resumes.
   */
  paused: "context_changed" | "conflict" | null;
};

/** Enters a context (the page's first render of the area). */
export function initialSyncState(
  snapshot: PreferencesSnapshot,
  generation = 1,
): SyncState {
  return {
    context: snapshot.context,
    generation,
    confirmed: snapshot.preferences,
    confirmedSeq: 0,
    nextSeq: 1,
    inFlight: null,
    pending: {},
    staleStreak: 0,
    paused: null,
  };
}

/**
 * The page entered a context again (another account or business, the same
 * one after a new sign-in, or after leaving and joining again): a new
 * generation. Nothing of the previous one is kept, not even unsent choices
 * (they were for that account), and its answers are ignored from now on.
 */
export function enterContext(
  state: SyncState,
  snapshot: PreferencesSnapshot,
): SyncState {
  return initialSyncState(snapshot, state.generation + 1);
}

/** What the area shows: the account's state with her unconfirmed choices. */
export function displayedAppearance(state: SyncState): AppearancePreferences {
  return { ...base(state), ...state.pending };
}

/** She changed something here (shown at once, sent by nextSave). */
export function changeLocally(
  state: SyncState,
  next: AppearancePreferences,
): SyncState {
  return { ...state, pending: changesBetween(base(state), next) };
}

/** The save to send now, if any (one at a time; none while paused). */
export function nextSave(state: SyncState): [SyncState, SaveRequest | null] {
  if (
    state.inFlight ||
    state.paused ||
    Object.keys(state.pending).length === 0
  ) {
    return [state, null];
  }
  const request: SaveRequest = {
    ticket: { generation: state.generation, seq: state.nextSeq },
    context: state.context,
    expected: {
      incarnation: state.confirmed.incarnation,
      version: state.confirmed.version,
    },
    changes: state.pending,
  };
  return [
    { ...state, nextSeq: state.nextSeq + 1, inFlight: request, pending: {} },
    request,
  ];
}

/** A read to send (focus, another tab): its ticket. */
export function startRead(state: SyncState): [SyncState, Ticket] {
  return [
    { ...state, nextSeq: state.nextSeq + 1 },
    { generation: state.generation, seq: state.nextSeq },
  ];
}

/** The answer to a save. */
export function saveAnswered(
  state: SyncState,
  ticket: Ticket,
  answer: SaveAnswer,
): SyncState {
  const sent = state.inFlight;
  if (!sent || !sameTicket(sent.ticket, ticket)) return state;
  if (!sameContext(answer.context, state.context)) {
    // Nothing of it is taken; her choice stays, unsent, for this context.
    return settle({
      ...state,
      inFlight: null,
      pending: { ...sent.changes, ...state.pending },
      paused: "context_changed",
    });
  }
  const stale = answer.status === "stale";
  const staleStreak = stale ? state.staleStreak + 1 : 0;
  return settle({
    ...adopt(state, ticket.seq, answer.preferences),
    inFlight: null,
    pending: stale ? { ...sent.changes, ...state.pending } : state.pending,
    staleStreak,
    paused: staleStreak >= STALE_LIMIT ? "conflict" : state.paused,
  });
}

/**
 * A save got no answer the device can use: `network` (no answer, the
 * database away…: sent again later) or `context_changed` (the session is
 * another context's: nothing more is sent from this one).
 */
export function saveFailed(
  state: SyncState,
  ticket: Ticket,
  reason: "network" | "context_changed",
): SyncState {
  const sent = state.inFlight;
  if (!sent || !sameTicket(sent.ticket, ticket)) return state;
  return settle({
    ...state,
    inFlight: null,
    pending: { ...sent.changes, ...state.pending },
    paused: reason === "context_changed" ? "context_changed" : state.paused,
  });
}

/** The answer to a read. */
export function readAnswered(
  state: SyncState,
  ticket: Ticket,
  snapshot: PreferencesSnapshot,
): SyncState {
  if (ticket.generation !== state.generation) return state;
  if (!sameContext(snapshot.context, state.context)) {
    return { ...state, paused: "context_changed" };
  }
  // The server has just answered for this very context: whatever paused
  // saving (a refusal while signed out or while the database was away, an
  // answer for another context, too many stale answers) no longer holds.
  return settle({
    ...adopt(state, ticket.seq, snapshot.preferences),
    staleStreak: 0,
    paused: null,
  });
}

function sameTicket(a: Ticket, b: Ticket) {
  return a.generation === b.generation && a.seq === b.seq;
}

function base(state: Pick<SyncState, "confirmed" | "inFlight">) {
  return { ...state.confirmed.appearance, ...state.inFlight?.changes };
}

/** `candidate`, answered to request `seq`, if it is newer than confirmed. */
function adopt(
  state: SyncState,
  seq: number,
  candidate: MemberPreferences,
): SyncState {
  const current = state.confirmed;
  const newer =
    candidate.incarnation !== null &&
    candidate.incarnation === current.incarnation
      ? candidate.version > current.version
      : seq > state.confirmedSeq;
  if (!newer) return state;
  return {
    ...state,
    confirmed: candidate,
    confirmedSeq: Math.max(seq, state.confirmedSeq),
  };
}

/** Pending reduced to what confirmed + inFlight does not already have. */
function settle(state: SyncState): SyncState {
  const from = base(state);
  return {
    ...state,
    pending: changesBetween(from, { ...from, ...state.pending }),
  };
}

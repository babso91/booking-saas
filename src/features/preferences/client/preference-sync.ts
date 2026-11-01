import {
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
// choices at once and sends them until the account acknowledges them.
//
// Two things are kept apart, and never inferred from each other:
//   * observed: the latest state of the account this device has seen (from
//     a read or from a save's answer). Reads only ever change this;
//   * intents: what she chose here, field by field, each with a revision.
//     An intent leaves only when a save that carried that very revision is
//     acknowledged (saved or unchanged, for its ticket). Never because the
//     observed state happens to hold the same value: an observed state may
//     be stale, and an equal value in it acknowledges nothing.
// What she sees is observed + intents.
//
// Isolation. Every answer is matched against three things, and ignored
// entirely (data, acknowledgement, failure) if one does not match:
//   * the generation: a number the device gives each context it enters.
//     Entering a context (another account, another business, the same one
//     again after leaving it, a new sign-in) starts a new generation;
//     answers to requests of an earlier generation are dropped, whatever
//     their content or version. Her intents of the previous context are
//     dropped too, deliberately: they were for that account;
//   * the context the server answered for (her membership): an answer for
//     another one means the session changed under this page; nothing of it
//     is taken, intents are kept, and saving pauses;
//   * the request: a save's answer or failure concerns that save only (its
//     ticket), never a later one.
//
// Freshness of observed states, within a context. A state is (incarnation,
// version). Within one incarnation, the higher version is the newer. Across
// incarnations (the row was deleted and created again, or does not exist),
// versions mean nothing: the answer to the request sent last is taken.
// That order is the order of sending, not of serving, so a stale state may
// be shown for a moment: it changes no intent, and when the device holds
// an answer it could not order, it asks for a read (`readAfter`).
//
// A save sends every intent (one save at a time), based on the observed
// state. Its answer:
//   saved / unchanged  the intents it carried, at the revisions it carried,
//                      are acknowledged; newer ones are sent next;
//   stale              nothing acknowledged; sent again on the state the
//                      answer brought;
//   failed (network)   nothing acknowledged; sent again later.
// After STALE_LIMIT stale answers in a row, saving pauses ("conflict")
// until a read brings the account's state again: never an endless loop.
// A refusal for the context (signed out, another session, or the session
// unreadable while the database is away: the server cannot tell) pauses it
// too; a read answered for this same context resumes it.

export const STALE_LIMIT = 5;

type Field = keyof AppearancePreferences;

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

/** Her choice for one field, and when she made it (a revision). */
export type Intent<F extends Field = Field> = {
  value: AppearancePreferences[F];
  rev: number;
};

export type Intents = { [F in Field]?: Intent<F> };

export type SyncState = {
  context: PreferenceContext;
  generation: number;
  /** The account's latest state seen here; never a confirmation of intents. */
  observed: MemberPreferences;
  /** The request whose answer brought `observed` (0: the page's render). */
  observedSeq: number;
  nextSeq: number;
  nextRev: number;
  /** Her choices not acknowledged yet (sent or not). */
  intents: Intents;
  /** The save being sent, with the revisions it carries. */
  inFlight: { request: SaveRequest; revs: { [F in Field]?: number } } | null;
  staleStreak: number;
  /**
   * context_changed: the session is not, or could not be shown to be, this
   * context's (another account, business or membership, signed out, or the
   * database away); conflict: too many stale answers. Nothing is sent while
   * paused; a read answered for this context resumes.
   */
  paused: "context_changed" | "conflict" | null;
  /**
   * A read is due: the device holds an answer it could not order with what
   * it observed. Cleared by a read sent from that point on (ticket.seq ≥).
   */
  readAfter: number | null;
};

/** Enters a context (the page's first render of the area). */
export function initialSyncState(
  snapshot: PreferencesSnapshot,
  generation = 1,
): SyncState {
  return {
    context: snapshot.context,
    generation,
    observed: snapshot.preferences,
    observedSeq: 0,
    nextSeq: 1,
    nextRev: 1,
    intents: {},
    inFlight: null,
    staleStreak: 0,
    paused: null,
    readAfter: null,
  };
}

/**
 * The page entered a context again (another account or business, the same
 * one after a new sign-in, or after leaving and joining again): a new
 * generation. Nothing of the previous one is kept, not even her intents
 * (they were for that account), and its answers are ignored from now on.
 */
export function enterContext(
  state: SyncState,
  snapshot: PreferencesSnapshot,
): SyncState {
  return initialSyncState(snapshot, state.generation + 1);
}

/** What the area shows: the account's state with her intents. */
export function displayedAppearance(state: SyncState): AppearancePreferences {
  const shown = { ...state.observed.appearance };
  for (const field of fields(state.intents)) {
    Object.assign(shown, { [field]: state.intents[field]!.value });
  }
  return shown;
}

/** Her choices not acknowledged by the account yet (sent or not). */
export function unacknowledgedChanges(state: SyncState): AppearanceChanges {
  const changes: AppearanceChanges = {};
  for (const field of fields(state.intents)) {
    Object.assign(changes, { [field]: state.intents[field]!.value });
  }
  return changes;
}

/**
 * She changed something here: each field that differs from what she sees
 * becomes an intent, at a new revision (shown at once, sent by nextSave).
 */
export function changeLocally(
  state: SyncState,
  next: AppearancePreferences,
): SyncState {
  const shown = displayedAppearance(state);
  const intents: Intents = { ...state.intents };
  let rev = state.nextRev;
  for (const field of Object.keys(next) as Field[]) {
    if (next[field] !== shown[field]) {
      Object.assign(intents, { [field]: { value: next[field], rev } });
      rev += 1;
    }
  }
  return rev === state.nextRev ? state : { ...state, intents, nextRev: rev };
}

/** The save to send now, if any (one at a time; none while paused). */
export function nextSave(state: SyncState): [SyncState, SaveRequest | null] {
  if (state.inFlight || state.paused || fields(state.intents).length === 0) {
    return [state, null];
  }
  const revs: { [F in Field]?: number } = {};
  for (const field of fields(state.intents)) {
    revs[field] = state.intents[field]!.rev;
  }
  const request: SaveRequest = {
    ticket: { generation: state.generation, seq: state.nextSeq },
    context: state.context,
    expected: {
      incarnation: state.observed.incarnation,
      version: state.observed.version,
    },
    changes: unacknowledgedChanges(state),
  };
  return [
    { ...state, nextSeq: state.nextSeq + 1, inFlight: { request, revs } },
    request,
  ];
}

/** A read to send (focus, another tab, readAfter): its ticket. */
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
  if (!sent || !sameTicket(sent.request.ticket, ticket)) return state;
  if (!sameContext(answer.context, state.context)) {
    // Nothing of it is taken; her intents stay, for this context.
    return { ...state, inFlight: null, paused: "context_changed" };
  }
  const observed = observe(state, ticket.seq, answer.preferences);
  if (answer.status === "stale") {
    const staleStreak = state.staleStreak + 1;
    return {
      ...observed,
      inFlight: null,
      staleStreak,
      paused: staleStreak >= STALE_LIMIT ? "conflict" : state.paused,
    };
  }
  // Acknowledged: exactly the intents this save carried, at the revisions
  // it carried. One she changed again since is newer, and stays.
  const intents: Intents = { ...state.intents };
  for (const field of Object.keys(sent.revs) as Field[]) {
    if (intents[field]?.rev === sent.revs[field]) delete intents[field];
  }
  return { ...observed, intents, inFlight: null, staleStreak: 0 };
}

/**
 * A save got no answer the device can use: `network` (no answer, the
 * database away…: sent again later) or `context_changed` (the session is
 * another context's, or could not be shown to be this one: paused). Her
 * intents stay either way.
 */
export function saveFailed(
  state: SyncState,
  ticket: Ticket,
  reason: "network" | "context_changed",
): SyncState {
  const sent = state.inFlight;
  if (!sent || !sameTicket(sent.request.ticket, ticket)) return state;
  return {
    ...state,
    inFlight: null,
    paused: reason === "context_changed" ? "context_changed" : state.paused,
  };
}

/** The answer to a read: the account's state, never an acknowledgement. */
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
  const observed = observe(state, ticket.seq, snapshot.preferences);
  return {
    ...observed,
    staleStreak: 0,
    paused: null,
    readAfter:
      observed.readAfter !== null && ticket.seq >= observed.readAfter
        ? null
        : observed.readAfter,
  };
}

function sameTicket(a: Ticket, b: Ticket) {
  return a.generation === b.generation && a.seq === b.seq;
}

function fields(intents: Intents) {
  return Object.keys(intents) as Field[];
}

function sameState(a: MemberPreferences, b: MemberPreferences) {
  return (
    a.incarnation === b.incarnation &&
    a.version === b.version &&
    JSON.stringify(a.appearance) === JSON.stringify(b.appearance)
  );
}

/**
 * `candidate`, answered to request `seq`, replaces the observed state if it
 * is newer. An answer that differs and cannot be ordered with it (another
 * incarnation, sent earlier) asks for a read. Intents are never touched.
 */
function observe(
  state: SyncState,
  seq: number,
  candidate: MemberPreferences,
): SyncState {
  const current = state.observed;
  const sameIncarnation =
    candidate.incarnation !== null &&
    candidate.incarnation === current.incarnation;
  const newer = sameIncarnation
    ? candidate.version > current.version
    : seq > state.observedSeq;
  if (newer) {
    return {
      ...state,
      observed: candidate,
      observedSeq: Math.max(seq, state.observedSeq),
    };
  }
  if (!sameIncarnation && !sameState(candidate, current)) {
    return { ...state, readAfter: state.readAfter ?? state.nextSeq };
  }
  return state;
}

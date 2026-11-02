import { describe, expect, it } from "vitest";

import {
  defaultAppearancePreferences,
  noMemberPreferences,
  sameContext,
  type AppearancePreferences,
  type MemberPreferences,
  type PreferenceContext,
  type PreferencesSnapshot,
} from "../model";
import {
  STALE_LIMIT,
  changeLocally,
  displayedAppearance,
  enterContext,
  initialSyncState,
  unacknowledgedChanges,
  nextSave,
  readAnswered,
  readFailed,
  readNeeded,
  saveAnswered,
  saveFailed,
  startRead,
  type SaveAnswer,
  type SaveRequest,
  type SyncState,
} from "./preference-sync";

// The server, as read_member_preferences and save_member_preferences
// behave (tested against PostgreSQL in tests/integration/), with
// memberships that can end and begin again, and a session that can change.
class Server {
  private rows = new Map<string, MemberPreferences>();
  private memberships = new Map<string, string>();
  private counter = 0;
  /** Writes really executed, per membership. */
  readonly writes: { membershipId: string; changes: object }[] = [];
  /** Which membership each state the server answered belongs to. */
  readonly origin = new Map<MemberPreferences, string>();

  join(userId: string, businessId: string): PreferenceContext {
    const membershipId = this.id();
    this.memberships.set(`${userId}:${businessId}`, membershipId);
    return { userId, businessId, membershipId };
  }

  leave(context: PreferenceContext) {
    this.memberships.delete(`${context.userId}:${context.businessId}`);
    this.rows.delete(context.membershipId);
  }

  /** An administrator deletes the row (the membership stays). */
  dropRow(context: PreferenceContext) {
    this.rows.delete(context.membershipId);
  }

  read(session: { userId: string; businessId: string }): PreferencesSnapshot {
    const context = this.contextOf(session);
    return {
      context,
      preferences: this.rows.get(context.membershipId) ?? noMemberPreferences,
    };
  }

  save(
    session: { userId: string; businessId: string },
    request: SaveRequest,
  ): SaveAnswer | "context_changed" {
    const context = this.contextOf(session);
    if (
      context.businessId !== request.context.businessId ||
      context.membershipId !== request.context.membershipId
    ) {
      return "context_changed";
    }
    const current = this.rows.get(context.membershipId) ?? noMemberPreferences;
    const next = { ...current.appearance, ...request.changes };
    if (JSON.stringify(next) === JSON.stringify(current.appearance)) {
      return { status: "unchanged", context, preferences: current };
    }
    if (
      current.incarnation !== request.expected.incarnation ||
      current.version !== request.expected.version
    ) {
      return { status: "stale", context, preferences: current };
    }
    const saved = {
      appearance: next,
      incarnation: current.incarnation ?? this.id(),
      version: current.version + 1,
    };
    this.rows.set(context.membershipId, saved);
    this.origin.set(saved, context.membershipId);
    this.writes.push({
      membershipId: context.membershipId,
      changes: request.changes,
    });
    return { status: "saved", context, preferences: saved };
  }

  private contextOf(session: { userId: string; businessId: string }) {
    const membershipId = this.memberships.get(
      `${session.userId}:${session.businessId}`,
    );
    if (!membershipId) throw new Error("forbidden");
    return { ...session, membershipId };
  }

  private id() {
    this.counter += 1;
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
  }
}

const look = (
  patch: Partial<AppearancePreferences> = {},
): AppearancePreferences => ({ ...defaultAppearancePreferences, ...patch });

/** Applies a save answer, as the driver does. */
function answerSave(
  state: SyncState,
  request: SaveRequest,
  answer: SaveAnswer | "context_changed",
) {
  return answer === "context_changed"
    ? saveFailed(state, request.ticket, "context_changed")
    : saveAnswered(state, request.ticket, answer);
}

/** Sends every pending save until the device is in step (or paused). */
function flush(
  state: SyncState,
  server: Server,
  session: { userId: string; businessId: string },
): SyncState {
  for (let round = 0; round < 20; round++) {
    const [sending, request] = nextSave(state);
    if (!request) return sending;
    state = answerSave(sending, request, server.save(session, request));
  }
  throw new Error("never settles");
}

function read(
  state: SyncState,
  server: Server,
  session: { userId: string; businessId: string },
) {
  const [reading, ticket] = startRead(state);
  return readAnswered(reading, ticket, server.read(session));
}

const A = { userId: "user-a", businessId: "business-1" };
const B = { userId: "user-b", businessId: "business-2" };

describe("preference sync: one context", () => {
  it("first account: the defaults; nothing to send until she changes something", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    const device = initialSyncState(server.read(A));
    expect(displayedAppearance(device)).toEqual(defaultAppearancePreferences);
    expect(nextSave(device)[1]).toBeNull();
  });

  it("Écrin on the laptop, found on the phone; a colour from the phone reaches the laptop", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let laptop = initialSyncState(server.read(A));
    laptop = flush(
      changeLocally(laptop, look({ style: "ecrin", mode: "dark" })),
      server,
      A,
    );
    let phone = initialSyncState(server.read(A));
    expect(displayedAppearance(phone)).toMatchObject({
      style: "ecrin",
      mode: "dark",
    });
    phone = flush(
      changeLocally(phone, {
        ...displayedAppearance(phone),
        accent: "#2F6F5E",
      }),
      server,
      A,
    );
    laptop = read(laptop, server, A);
    expect(displayedAppearance(laptop)).toEqual(
      look({ style: "ecrin", mode: "dark", accent: "#2F6F5E" }),
    );
  });

  it("one save at a time; she undoes a choice while it is sent: her last choice wins", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ accent: "#BBBBBB" }));
    const [sending, request] = nextSave(device);
    device = changeLocally(sending, look());
    expect(nextSave(device)[1]).toBeNull();
    device = answerSave(device, request!, server.save(A, request!));
    device = flush(device, server, A);
    expect(server.read(A).preferences.appearance.accent).toBeNull();
    expect(displayedAppearance(device).accent).toBeNull();
  });

  it("stale: another device saved first; her change is applied on the new state, the other kept", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let laptop = initialSyncState(server.read(A));
    flush(
      changeLocally(initialSyncState(server.read(A)), look({ mode: "dark" })),
      server,
      A,
    );
    laptop = changeLocally(laptop, look({ ambiance: "sauge" }));
    const [sending, request] = nextSave(laptop);
    const answer = server.save(A, request!);
    expect(answer).toMatchObject({ status: "stale" });
    laptop = flush(answerSave(sending, request!, answer), server, A);
    expect(server.read(A).preferences.appearance).toMatchObject({
      mode: "dark",
      ambiance: "sauge",
    });
    expect(displayedAppearance(laptop)).toEqual(
      server.read(A).preferences.appearance,
    );
  });

  it("two answers out of order: the older one never replaces the newer", () => {
    const server = new Server();
    const context = server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    const [r1, first] = startRead(device);
    const [r2, second] = startRead(r1);
    const old = server.read(A);
    flush(
      changeLocally(
        initialSyncState(server.read(A)),
        look({ accent: "#222222" }),
      ),
      server,
      A,
    );
    const fresh = server.read(A);
    device = readAnswered(r2, second, fresh);
    device = readAnswered(device, first, old);
    expect(displayedAppearance(device).accent).toBe("#222222");
    expect(device.context).toEqual(context);
  });

  it("network error or database away: nothing is lost, the same change is sent again", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ style: "carnet" }));
    const [sending, request] = nextSave(device);
    device = saveFailed(sending, request!.ticket, "network");
    expect(displayedAppearance(device).style).toBe("carnet");
    expect(nextSave(device)[1]).toMatchObject({ changes: request!.changes });
    device = flush(device, server, A);
    expect(server.read(A).preferences.appearance.style).toBe("carnet");
  });

  it("an answer lost after the account saved: the retry is 'unchanged', and settles", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ style: "studio" }));
    const [sending, request] = nextSave(device);
    server.save(A, request!);
    device = saveFailed(sending, request!.ticket, "network");
    const [again, retry] = nextSave(device);
    const answer = server.save(A, retry!);
    expect(answer).toMatchObject({ status: "unchanged" });
    device = answerSave(again, retry!, answer);
    expect(device.observed.version).toBe(1);
    expect(nextSave(device)[1]).toBeNull();
  });

  it("an old failure (or answer) never ends a newer save", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ style: "studio" }));
    const [s1, first] = nextSave(device);
    device = saveFailed(s1, first!.ticket, "network");
    device = changeLocally(device, look({ style: "ecrin" }));
    const [s2, second] = nextSave(device);
    // The first request's late failure, then its late answer.
    let after = saveFailed(s2, first!.ticket, "network");
    after = saveAnswered(after, first!.ticket, {
      status: "saved",
      context: server.read(A).context,
      preferences: {
        appearance: look({ style: "studio" }),
        incarnation: "11111111-1111-4111-8111-111111111111",
        version: 1,
      },
    });
    expect(after).toEqual(s2);
    expect(after.inFlight?.request).toEqual(second);
  });

  it("repeated identical writes send nothing", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = flush(
      changeLocally(
        initialSyncState(server.read(A)),
        look({ style: "studio" }),
      ),
      server,
      A,
    );
    for (let index = 0; index < 5; index++) {
      device = changeLocally(device, look({ style: "studio" }));
      expect(nextSave(device)[1]).toBeNull();
    }
    expect(server.writes).toHaveLength(1);
  });

  it("no endless stale loop: after STALE_LIMIT stale answers, saving pauses until a read", () => {
    let device = initialSyncState({
      context: { ...A, membershipId: "m" },
      preferences: noMemberPreferences,
    });
    device = changeLocally(device, look({ style: "studio" }));
    let sent = 0;
    for (;;) {
      const [sending, request] = nextSave(device);
      if (!request) break;
      sent += 1;
      // An answer that never moves (a misbehaving server).
      device = saveAnswered(sending, request.ticket, {
        status: "stale",
        context: request.context,
        preferences: noMemberPreferences,
      });
      if (sent > 50) throw new Error("endless");
    }
    expect(sent).toBe(STALE_LIMIT);
    expect(device.paused).toBe("conflict");
    expect(displayedAppearance(device).style).toBe("studio");
    const [reading, ticket] = startRead(device);
    device = readAnswered(reading, ticket, {
      context: { ...A, membershipId: "m" },
      preferences: noMemberPreferences,
    });
    expect(device.paused).toBeNull();
    expect(nextSave(device)[1]).toMatchObject({ changes: { style: "studio" } });
  });
});

describe("preference sync: a stale read never erases an intent", () => {
  /** Codex's interleaving, against the server: returns the device and the server. */
  function codexInterleaving(order: "r1-then-r2" | "r2-then-r1") {
    const server = new Server();
    server.join(A.userId, A.businessId);
    const other = initialSyncState(server.read(A));
    let device = initialSyncState(server.read(A));
    // R1 is sent, its SQL delayed; R2 is sent and reads "no preferences"
    // at once, its answer held.
    const [s1, r1] = startRead(device);
    const [s2, r2] = startRead(s1);
    const r2Answer = server.read(A);
    // Écrin is created (another tab of hers).
    flush(changeLocally(other, look({ style: "ecrin" })), server, A);
    // R1's SQL runs now: it reads Écrin.
    const r1Answer = server.read(A);
    device = s2;
    const deliver = (state: SyncState, which: "r1" | "r2") =>
      which === "r1"
        ? readAnswered(state, r1, r1Answer)
        : readAnswered(state, r2, r2Answer);
    if (order === "r2-then-r1") device = deliver(device, "r2");
    device = deliver(device, "r1");
    if (order === "r2-then-r1") {
      // R1, sent first, answers last: it cannot be ordered with R2 (another
      // incarnation); the device asks for a read, as the driver does.
      expect(device.readAfter).not.toBeNull();
      device = read(device, server, A);
    }
    expect(displayedAppearance(device).style).toBe("ecrin");
    // An accent save starts; meanwhile she picks Classique.
    device = changeLocally(device, {
      ...displayedAppearance(device),
      accent: "#123456",
    });
    const [sending, accentSave] = nextSave(device);
    device = changeLocally(sending, {
      ...displayedAppearance(sending),
      style: "classique",
    });
    expect(displayedAppearance(device).style).toBe("classique");
    // R2's old answer arrives now (if not already).
    if (order === "r1-then-r2") device = deliver(device, "r2");
    expect(displayedAppearance(device).style).toBe("classique");
    expect(unacknowledgedChanges(device)).toMatchObject({ style: "classique" });
    // The accent save ends; then the device settles.
    device = answerSave(device, accentSave!, server.save(A, accentSave!));
    expect(unacknowledgedChanges(device)).toEqual({ style: "classique" });
    const [next] = [nextSave(device)[1]];
    expect(next?.changes).toMatchObject({ style: "classique" });
    device = flush(device, server, A);
    return { server, device };
  }

  it.each(["r1-then-r2", "r2-then-r1"] as const)(
    "Codex's interleaving (%s): Classique is kept, sent, saved by the server, and shown",
    (order) => {
      const { server, device } = codexInterleaving(order);
      expect(server.read(A).preferences.appearance).toMatchObject({
        style: "classique",
        accent: "#123456",
      });
      expect(device.intents).toEqual({});
      const [reading, ticket] = startRead(device);
      const fresh = readAnswered(reading, ticket, server.read(A));
      expect(displayedAppearance(fresh)).toEqual(
        server.read(A).preferences.appearance,
      );
    },
  );

  it("a read of an old incarnation during a save changes no intent", () => {
    const server = new Server();
    const context = server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    device = flush(changeLocally(device, look({ style: "studio" })), server, A);
    const [reading, oldTicket] = startRead(device);
    const old = server.read(A);
    server.dropRow(context);
    device = changeLocally(reading, look({ style: "studio", motion: "none" }));
    const [sending, save] = nextSave(device);
    device = changeLocally(sending, look({ style: "carnet", motion: "none" }));
    device = readAnswered(device, oldTicket, old);
    expect(unacknowledgedChanges(device)).toEqual({
      style: "carnet",
      motion: "none",
    });
    device = flush(answerSave(device, save!, server.save(A, save!)), server, A);
    expect(server.read(A).preferences.appearance).toMatchObject({
      style: "carnet",
      motion: "none",
    });
  });

  it.each([
    ["equal to the stale state", "classique"],
    ["different from the stale state", "carnet"],
  ] as const)("a local choice %s survives the stale read", (_label, style) => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    const [reading, staleTicket] = startRead(device);
    const stale = server.read(A);
    flush(
      changeLocally(initialSyncState(server.read(A)), look({ style: "ecrin" })),
      server,
      A,
    );
    device = read(reading, server, A);
    device = changeLocally(device, look({ style }));
    device = readAnswered(device, staleTicket, stale);
    expect(unacknowledgedChanges(device)).toEqual({ style });
    device = flush(device, server, A);
    expect(server.read(A).preferences.appearance.style).toBe(style);
  });

  it("several successive choices of one field: an acknowledgement of an older one never removes the newer", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ accent: "#000001" }));
    const [sending, first] = nextSave(device);
    device = changeLocally(sending, look({ accent: "#000002" }));
    device = changeLocally(device, look({ accent: "#000003" }));
    device = answerSave(device, first!, server.save(A, first!));
    expect(unacknowledgedChanges(device)).toEqual({ accent: "#000003" });
    device = flush(device, server, A);
    expect(server.read(A).preferences.appearance.accent).toBe("#000003");
    expect(server.writes).toHaveLength(2);
  });

  it("'unchanged' for an older choice never removes a newer one", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ style: "studio" }));
    const [sending, first] = nextSave(device);
    // The account already has Studio (another device).
    flush(
      changeLocally(
        initialSyncState(server.read(A)),
        look({ style: "studio" }),
      ),
      server,
      A,
    );
    device = changeLocally(sending, look({ style: "ecrin" }));
    const answer = server.save(A, first!);
    expect(answer).toMatchObject({ status: "unchanged" });
    device = answerSave(device, first!, answer);
    expect(unacknowledgedChanges(device)).toEqual({ style: "ecrin" });
    device = flush(device, server, A);
    expect(server.read(A).preferences.appearance.style).toBe("ecrin");
  });

  it("'stale' after a newer local choice: all her intents are sent again, the newest values", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ accent: "#000001" }));
    const [sending, first] = nextSave(device);
    flush(
      changeLocally(initialSyncState(server.read(A)), look({ mode: "dark" })),
      server,
      A,
    );
    device = changeLocally(
      sending,
      look({ accent: "#000001", style: "carnet" }),
    );
    const answer = server.save(A, first!);
    expect(answer).toMatchObject({ status: "stale" });
    device = answerSave(device, first!, answer);
    const [, again] = nextSave(device);
    expect(again?.changes).toEqual({ accent: "#000001", style: "carnet" });
    expect(again?.expected).toEqual({
      incarnation: server.read(A).preferences.incarnation,
      version: server.read(A).preferences.version,
    });
    device = flush(device, server, A);
    expect(server.read(A).preferences.appearance).toMatchObject({
      mode: "dark",
      accent: "#000001",
      style: "carnet",
    });
  });

  it("a fresh read after a successful save shows the account; nothing left to send", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = flush(
      changeLocally(
        initialSyncState(server.read(A)),
        look({ style: "studio" }),
      ),
      server,
      A,
    );
    device = read(device, server, A);
    expect(device.intents).toEqual({});
    expect(displayedAppearance(device)).toEqual(
      server.read(A).preferences.appearance,
    );
    expect(nextSave(device)[1]).toBeNull();
  });

  it("an answer it cannot order asks for a read, which settles what she sees", () => {
    const server = new Server();
    const context = server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ style: "studio" }));
    const [sending, save] = nextSave(device);
    // A read sent after the save is served before it: no row.
    const [reading, ticket] = startRead(sending);
    const early = server.read(A);
    const answer = server.save(A, save!);
    device = readAnswered(reading, ticket, early);
    device = answerSave(device, save!, answer);
    // Saved, acknowledged; the observed state (sent later) wins for now.
    expect(device.intents).toEqual({});
    expect(device.readAfter).not.toBeNull();
    device = read(device, server, A);
    expect(device.readAfter).toBeNull();
    expect(displayedAppearance(device).style).toBe("studio");
    void context;
  });
});

/**
 * The driver's reconciliation: reads while readNeeded says so (one at a
 * time), as the provider does without waiting for a focus. Counts reads.
 */
function reconcile(
  state: SyncState,
  server: Server,
  session: { userId: string; businessId: string },
) {
  let reads = 0;
  while (readNeeded(state)) {
    if (++reads > 10) throw new Error("read loop");
    const [reading, ticket] = startRead(state);
    state = readAnswered(reading, ticket, server.read(session));
  }
  return { state, reads };
}

/** Her other tab deletes nothing; an administrator deletes the row, her other tab recreates it. */
function recreate(server: Server, accent: string) {
  server.dropRow(server.read(A).context);
  flush(
    changeLocally(initialSyncState(server.read(A)), look({ accent })),
    server,
    A,
  );
}

describe("preference sync: reconciliation reads (readAfter)", () => {
  it("Codex: a save acknowledged during a read, then the row recreated; that read's answer never clears the new barrier", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    // A first barrier: an early read that cannot be ordered.
    const [r0, early] = startRead(device);
    device = flush(changeLocally(r0, look({ style: "studio" })), server, A);
    recreate(server, "#000009");
    device = readAnswered(device, early, server.read(A));
    expect(readNeeded(device)).toBe(true);
    // The reconciliation read R is sent, its answer delayed.
    const [reading, r] = startRead(device);
    expect(readNeeded(reading)).toBe(false);
    // Meanwhile a save is acknowledged on the incarnation X it read…
    device = changeLocally(reading, {
      ...displayedAppearance(reading),
      motion: "none",
    });
    device = flush(device, server, A);
    const x = server.read(A).preferences.incarnation;
    // …and the row is deleted and recreated: Y. R is served now: Y.
    recreate(server, "#00000A");
    const answerR = server.read(A);
    expect(answerR.preferences.incarnation).not.toBe(x);
    device = readAnswered(device, r, answerR);
    // R was sent before the save's answer: it cannot settle that.
    expect(device.readAfter).not.toBeNull();
    expect(readNeeded(device)).toBe(true);
    const done = reconcile(device, server, A);
    expect(done.reads).toBe(1);
    expect(displayedAppearance(done.state)).toEqual(
      server.read(A).preferences.appearance,
    );
    expect(readNeeded(done.state)).toBe(false);
  });

  it("one read in flight, then a new ambiguity: the read in flight does not count, another is due", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = flush(
      changeLocally(
        initialSyncState(server.read(A)),
        look({ style: "studio" }),
      ),
      server,
      A,
    );
    const [r1s, r1] = startRead(device);
    const old = server.read(A);
    recreate(server, "#000001");
    const [r2s, r2] = startRead(r1s);
    device = readAnswered(r2s, r2, server.read(A));
    // r1 (sent before r2) answers the old incarnation: an ambiguity.
    device = readAnswered(device, r1, old);
    expect(device.readAfter).toBe(device.nextSeq);
    expect(readNeeded(device)).toBe(true);
    const [r3s] = startRead(device);
    expect(readNeeded(r3s)).toBe(false);
  });

  it("a read still on its way, sent before a new ambiguity, does not count for it: another read is due", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    const [s1, early] = startRead(device);
    // A read (focus) is sent, its answer still on its way.
    const [s2] = startRead(s1);
    recreate(server, "#000001");
    const [s3, later] = startRead(s2);
    device = readAnswered(s3, later, server.read(A));
    device = readAnswered(device, early, {
      context: server.read(A).context,
      preferences: noMemberPreferences,
    });
    expect(device.readsInFlight).toHaveLength(1);
    expect(device.readsInFlight[0]!).toBeLessThan(device.readAfter!);
    expect(readNeeded(device)).toBe(true);
  });

  it("two reads answered in reverse order: the older never clears the barrier the newer must clear", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    const [s1, early] = startRead(device);
    recreate(server, "#000001");
    const [s2, later] = startRead(s1);
    device = readAnswered(s2, later, server.read(A));
    // The early read, answered last, reports "no row": an ambiguity.
    device = readAnswered(device, early, {
      context: server.read(A).context,
      preferences: noMemberPreferences,
    });
    expect(readNeeded(device)).toBe(true);
    const [s3, first] = startRead(device);
    const [s4, second] = startRead(s3);
    const answer = server.read(A);
    // Reversed answers; both were sent after the barrier: either clears it.
    device = readAnswered(s4, second, answer);
    expect(device.readAfter).toBeNull();
    device = readAnswered(device, first, answer);
    expect(device.readAfter).toBeNull();
    expect(device.readsInFlight).toEqual([]);
  });

  it("two recreations in a row, a new ambiguity during the reconciliation: converges, a bounded number of reads", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = flush(
      changeLocally(initialSyncState(server.read(A)), look({ style: "ecrin" })),
      server,
      A,
    );
    const [s1, stale1] = startRead(device);
    const old1 = server.read(A);
    recreate(server, "#000001");
    const [s2, fresh] = startRead(s1);
    device = readAnswered(s2, fresh, server.read(A));
    device = readAnswered(device, stale1, old1);
    expect(readNeeded(device)).toBe(true);
    const [s3, reconciling] = startRead(device);
    const old2 = server.read(A);
    recreate(server, "#000002");
    // A newer read first, then the reconciliation read's old answer.
    const [s4, newer] = startRead(s3);
    device = readAnswered(s4, newer, server.read(A));
    device = readAnswered(device, reconciling, old2);
    expect(readNeeded(device)).toBe(true);
    const done = reconcile(device, server, A);
    expect(done.reads).toBe(1);
    expect(done.state.observed).toEqual(server.read(A).preferences);
  });

  it("a reconciliation read that fails: due again (the driver waits), then settles; never stuck", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    const [s1, early] = startRead(device);
    recreate(server, "#000001");
    const [s2, later] = startRead(s1);
    device = readAnswered(s2, later, server.read(A));
    device = readAnswered(device, early, {
      context: server.read(A).context,
      preferences: noMemberPreferences,
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(readNeeded(device)).toBe(true);
      const [reading, ticket] = startRead(device);
      expect(readNeeded(reading)).toBe(false);
      device = readFailed(reading, ticket);
    }
    expect(device.readsInFlight).toEqual([]);
    const done = reconcile(device, server, A);
    expect(done.reads).toBe(1);
    expect(readNeeded(done.state)).toBe(false);
  });

  it("a context change during the reconciliation: barrier and reads of the old context are gone, their answers ignored", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    server.join(B.userId, B.businessId);
    let device = initialSyncState(server.read(A));
    const [s1, early] = startRead(device);
    recreate(server, "#000001");
    const [s2, later] = startRead(s1);
    device = readAnswered(s2, later, server.read(A));
    device = readAnswered(device, early, {
      context: server.read(A).context,
      preferences: noMemberPreferences,
    });
    const [reading, ticket] = startRead(device);
    const b = enterContext(reading, server.read(B));
    expect(readNeeded(b)).toBe(false);
    expect(b.readsInFlight).toEqual([]);
    expect(readAnswered(b, ticket, server.read(A))).toEqual(b);
    expect(readFailed(b, ticket)).toEqual(b);
  });

  it("an old context's read failure or answer never settles a read of the new context with the same number", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    server.join(B.userId, B.businessId);
    const [a, oldTicket] = startRead(initialSyncState(server.read(A)));
    // The new context numbers its requests from 1 again.
    const [b, same] = startRead(enterContext(a, server.read(B)));
    expect(same.seq).toBe(oldTicket.seq);
    expect(b.readsInFlight).toEqual([same.seq]);
    expect(readFailed(b, oldTicket)).toEqual(b);
    expect(readAnswered(b, oldTicket, server.read(A))).toEqual(b);
    expect(readFailed(b, same).readsInFlight).toEqual([]);
  });

  it("an intent unacknowledged through the whole sequence stays, then is saved", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ style: "carnet" }));
    const [s1, early] = startRead(device);
    recreate(server, "#000001");
    const [s2, later] = startRead(s1);
    device = readAnswered(s2, later, server.read(A));
    device = readAnswered(device, early, {
      context: server.read(A).context,
      preferences: noMemberPreferences,
    });
    const [reading, ticket] = startRead(device);
    device = readFailed(reading, ticket);
    recreate(server, "#000002");
    device = reconcile(device, server, A).state;
    expect(unacknowledgedChanges(device)).toEqual({ style: "carnet" });
    device = flush(device, server, A);
    expect(server.read(A).preferences.appearance).toMatchObject({
      style: "carnet",
      accent: "#000002",
    });
    expect(device.intents).toEqual({});
  });

  it("a stable account raises no barrier: reads never loop", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = flush(
      changeLocally(
        initialSyncState(server.read(A)),
        look({ style: "studio" }),
      ),
      server,
      A,
    );
    for (let index = 0; index < 5; index++) device = read(device, server, A);
    expect(device.readAfter).toBeNull();
    expect(readNeeded(device)).toBe(false);
    expect(reconcile(device, server, A).reads).toBe(0);
  });
});

describe("preference sync: contexts are isolated", () => {
  function switchedDuringSave() {
    const server = new Server();
    server.join(A.userId, A.businessId);
    server.join(B.userId, B.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(
      device,
      look({ style: "studio", accent: "#AAAAAA" }),
    );
    const [sendingA, requestA] = nextSave(device);
    // She signs out; B signs in on the same device: the page enters B.
    let b = enterContext(sendingA, server.read(B));
    b = changeLocally(b, look({ motion: "none" }));
    const [sendingB, requestB] = nextSave(b);
    return { server, requestA: requestA!, sendingB, requestB: requestB! };
  }

  it("A → B during a save: A's answer changes nothing of B, and does not end B's save", () => {
    const { server, requestA, sendingB, requestB } = switchedDuringSave();
    const answerA = server.save(A, requestA) as SaveAnswer;
    expect(answerA.preferences.version).toBe(1);
    const after = saveAnswered(sendingB, requestA.ticket, answerA);
    expect(after).toEqual(sendingB);
    expect(displayedAppearance(after)).toEqual(look({ motion: "none" }));
    expect(after.inFlight?.request).toEqual(requestB);
  });

  it("A → B: A's late failure does not drop B's retry", () => {
    const { requestA, sendingB, requestB } = switchedDuringSave();
    const after = saveFailed(sendingB, requestA.ticket, "network");
    expect(after).toEqual(sendingB);
    const failedB = saveFailed(after, requestB.ticket, "network");
    expect(nextSave(failedB)[1]).toMatchObject({ changes: { motion: "none" } });
  });

  it("A → B: a request of A executed under B's session writes nothing (context_changed)", () => {
    const { server, requestA, sendingB } = switchedDuringSave();
    // The page of A sends its save after the cookie already is B's.
    expect(server.save(B, requestA)).toBe("context_changed");
    expect(server.writes).toEqual([]);
    expect(saveFailed(sendingB, requestA.ticket, "context_changed")).toEqual(
      sendingB,
    );
  });

  it("A → B during a read: A's read answer is ignored, even with a higher version", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    server.join(B.userId, B.businessId);
    flush(
      changeLocally(
        initialSyncState(server.read(A)),
        look({ style: "studio" }),
      ),
      server,
      A,
    );
    const device = initialSyncState(server.read(A));
    const [reading, ticketA] = startRead(device);
    const b = enterContext(reading, server.read(B));
    const after = readAnswered(b, ticketA, server.read(A));
    expect(after).toEqual(b);
    expect(displayedAppearance(after).style).toBe("classique");
  });

  it("A → B → A: an answer of the first A session is ignored by the second", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    server.join(B.userId, B.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ accent: "#111111" }));
    const [sendingA1, requestA1] = nextSave(device);
    let again = enterContext(
      enterContext(sendingA1, server.read(B)),
      server.read(A),
    );
    again = changeLocally(again, look({ accent: "#333333" }));
    const [sendingA2, requestA2] = nextSave(again);
    const late = server.save(A, requestA1!) as SaveAnswer;
    const after = saveAnswered(sendingA2, requestA1!.ticket, late);
    expect(after).toEqual(sendingA2);
    const done = flush(
      answerSave(after, requestA2!, server.save(A, requestA2!)),
      server,
      A,
    );
    expect(server.read(A).preferences.appearance.accent).toBe("#333333");
    expect(displayedAppearance(done).accent).toBe("#333333");
  });

  it("same professional, another business: the other business's answers are ignored", () => {
    const server = new Server();
    const other = { userId: A.userId, businessId: "business-3" };
    server.join(A.userId, A.businessId);
    server.join(other.userId, other.businessId);
    const first = initialSyncState(server.read(A));
    const [reading, ticket] = startRead(first);
    const second = enterContext(reading, server.read(other));
    expect(readAnswered(second, ticket, server.read(A))).toEqual(second);
  });

  it("an answer for another context in the current generation pauses saving (the session changed under the page)", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    server.join(B.userId, B.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ style: "studio" }));
    const [reading, ticket] = startRead(device);
    device = readAnswered(reading, ticket, server.read(B));
    expect(device.paused).toBe("context_changed");
    expect(displayedAppearance(device).style).toBe("studio");
    expect(device.observed).toEqual(noMemberPreferences);
    expect(nextSave(device)[1]).toBeNull();
  });

  it("a save answered for another context (never by this server, but never trusted) is not taken, and pauses", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    server.join(B.userId, B.businessId);
    flush(
      changeLocally(
        initialSyncState(server.read(B)),
        look({ style: "carnet" }),
      ),
      server,
      B,
    );
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ style: "studio" }));
    const [sending, request] = nextSave(device);
    device = saveAnswered(sending, request!.ticket, {
      status: "saved",
      ...server.read(B),
    });
    expect(device.observed).toEqual(noMemberPreferences);
    expect(device.paused).toBe("context_changed");
    expect(displayedAppearance(device).style).toBe("studio");
  });

  it("paused by a refusal (signed out, database away), resumed by a read answered for this same context only", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    server.join(B.userId, B.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ style: "studio" }));
    const [sending, request] = nextSave(device);
    device = saveFailed(sending, request!.ticket, "context_changed");
    expect(device.paused).toBe("context_changed");
    expect(nextSave(device)[1]).toBeNull();
    // The session now answers for B: still paused, nothing of B taken.
    device = read(device, server, B);
    expect(device.paused).toBe("context_changed");
    expect(device.observed).toEqual(noMemberPreferences);
    // It answers for A again: her choice is sent, to A.
    device = read(device, server, A);
    expect(device.paused).toBeNull();
    device = flush(device, server, A);
    expect(server.read(A).preferences.appearance.style).toBe("studio");
    expect(server.read(B).preferences.version).toBe(0);
  });

  it("signed out then in again: a new generation; the earlier session's answers are ignored", () => {
    const server = new Server();
    server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ style: "studio" }));
    const [sending, request] = nextSave(device);
    const answer = server.save(A, request!) as SaveAnswer;
    const signedInAgain = enterContext(sending, server.read(A));
    expect(saveAnswered(signedInAgain, request!.ticket, answer)).toEqual(
      signedInAgain,
    );
    expect(displayedAppearance(signedInAgain).style).toBe("studio");
  });
});

describe("preference sync: leaving and joining again", () => {
  it("left and joined again: a new context; its state at version 0 is taken, and saving works", () => {
    const server = new Server();
    let context = server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    for (let index = 0; index < 3; index++) {
      device = flush(
        changeLocally(device, look({ accent: `#00000${index}` })),
        server,
        A,
      );
    }
    expect(device.observed.version).toBe(3);

    for (let cycle = 0; cycle < 3; cycle++) {
      server.leave(context);
      context = server.join(A.userId, A.businessId);
      const wanted = look({ style: "carnet", accent: `#0000A${cycle}` });
      // The page saves with the old context: refused, nothing written.
      device = changeLocally(device, wanted);
      const [sending, request] = nextSave(device);
      const refused = server.save(A, request!);
      expect(refused).toBe("context_changed");
      device = answerSave(sending, request!, refused);
      expect(device.paused).toBe("context_changed");
      // The page renders again: the new membership, no row (version 0).
      device = enterContext(device, server.read(A));
      expect(device.observed).toEqual(noMemberPreferences);
      device = flush(changeLocally(device, wanted), server, A);
      expect(server.read(A).preferences).toMatchObject({
        appearance: wanted,
        version: 1,
      });
      expect(device.paused).toBeNull();
    }
  });

  it("a late answer of the old membership after joining again is ignored", () => {
    const server = new Server();
    const old = server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ style: "studio" }));
    const [sending, request] = nextSave(device);
    const late = server.save(A, request!) as SaveAnswer;
    server.leave(old);
    server.join(A.userId, A.businessId);
    const fresh = enterContext(sending, server.read(A));
    expect(saveAnswered(fresh, request!.ticket, late)).toEqual(fresh);
    expect(displayedAppearance(fresh).style).toBe("classique");
  });

  it("the row deleted and created again in the same membership: versions are not compared across incarnations", () => {
    const server = new Server();
    const context = server.join(A.userId, A.businessId);
    let laptop = initialSyncState(server.read(A));
    for (let index = 0; index < 4; index++) {
      laptop = flush(
        changeLocally(laptop, look({ accent: `#00000${index}` })),
        server,
        A,
      );
    }
    const phone = initialSyncState(server.read(A));
    expect(laptop.observed.version).toBe(4);
    server.dropRow(context);
    // The phone recreates it (version 1 of a new incarnation).
    const recreated = flush(
      changeLocally(
        enterContext(phone, server.read(A)),
        look({ motion: "none" }),
      ),
      server,
      A,
    );
    expect(recreated.observed).toMatchObject({ version: 1 });
    expect(recreated.observed.incarnation).not.toBe(
      laptop.observed.incarnation,
    );
    // The laptop, still at version 4 of the old incarnation, changes the
    // style while it does not know: stale once, then saved.
    laptop = changeLocally(laptop, {
      ...displayedAppearance(laptop),
      style: "ecrin",
    });
    laptop = flush(laptop, server, A);
    expect(server.read(A).preferences.appearance).toMatchObject({
      style: "ecrin",
      motion: "none",
    });
    expect(laptop.paused).toBeNull();
    // A late read of the old incarnation (sent before) never comes back;
    // the device, holding an answer it cannot order, asks for a read.
    const [reading, ticket] = startRead(laptop);
    const newest = readAnswered(reading, ticket, server.read(A));
    const late = readAnswered(
      newest,
      { generation: newest.generation, seq: 1 },
      {
        context: server.read(A).context,
        preferences: {
          appearance: look({ accent: "#000003" }),
          incarnation: "00000000-0000-4000-8000-000000000099",
          version: 4,
        },
      },
    );
    expect(late.observed).toEqual(newest.observed);
    expect(late.intents).toEqual(newest.intents);
    expect(late.readAfter).toBe(newest.nextSeq);
    const [again, fresh] = startRead(late);
    expect(readAnswered(again, fresh, server.read(A)).readAfter).toBeNull();
  });

  it("a local change while she leaves and joins again is not sent to the new membership", () => {
    const server = new Server();
    const old = server.join(A.userId, A.businessId);
    let device = initialSyncState(server.read(A));
    device = changeLocally(device, look({ style: "studio" }));
    server.leave(old);
    server.join(A.userId, A.businessId);
    device = enterContext(device, server.read(A));
    expect(nextSave(device)[1]).toBeNull();
    expect(server.writes).toEqual([]);
  });
});

/**
 * An intent may leave a device's state only if a save that carried that
 * very revision was acknowledged (saved or unchanged), if a newer revision
 * of the same field replaced it, or if the device entered a new context.
 */
function checkIntents(
  before: SyncState,
  after: SyncState,
  how:
    | {
        kind: "acknowledged";
        request: SaveRequest;
        revs: Record<string, number>;
      }
    | { kind: "other" },
) {
  if (after.generation !== before.generation) return;
  for (const [field, intent] of Object.entries(before.intents)) {
    const now = after.intents[field as keyof typeof after.intents];
    if (now?.rev === intent!.rev) continue;
    if (now && now.rev > intent!.rev) continue;
    expect(
      how.kind === "acknowledged" && how.revs[field] === intent!.rev,
      `intent ${field}@${intent!.rev} lost`,
    ).toBe(true);
  }
}

describe("preference sync: random interleavings", () => {
  it("two devices, stale and reordered reads, session changes: no answer crosses contexts, no intent is ever lost, everything ends in step", () => {
    let seed = 11;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const colours = [null, "#000001", "#000002", "#000003"];
    const styles = ["classique", "ecrin", "studio"] as const;
    for (let run = 0; run < 400; run++) {
      const server = new Server();
      const contexts = [server.join(A.userId, A.businessId)];
      server.join(B.userId, B.businessId);
      const sessions = [A, A];
      const devices = [
        initialSyncState(server.read(A)),
        initialSyncState(server.read(A)),
      ];
      const inFlight: ({ request: SaveRequest; session: typeof A } | null)[] = [
        null,
        null,
      ];
      const reads: {
        ticket: ReturnType<typeof startRead>[1];
        snapshot: PreferencesSnapshot;
      }[][] = [[], []];
      const step = (
        index: number,
        next: SyncState,
        how: Parameters<typeof checkIntents>[2] = { kind: "other" },
      ) => {
        checkIntents(devices[index]!, next, how);
        devices[index] = next;
      };
      for (let turn = 0; turn < 50; turn++) {
        const index = random() < 0.5 ? 0 : 1;
        const roll = random();
        const device = devices[index]!;
        if (roll < 0.3) {
          step(
            index,
            changeLocally(device, {
              ...displayedAppearance(device),
              ...(random() < 0.5
                ? { accent: colours[Math.floor(random() * colours.length)]! }
                : { style: styles[Math.floor(random() * styles.length)]! }),
            }),
          );
        } else if (roll < 0.45 && !inFlight[index]) {
          const [state, request] = nextSave(device);
          step(index, state);
          if (request) inFlight[index] = { request, session: sessions[index]! };
        } else if (roll < 0.6 && inFlight[index]) {
          const { request, session } = inFlight[index]!;
          const answer = server.save(session, request);
          const revs =
            device.inFlight?.request === request ? device.inFlight.revs : {};
          step(
            index,
            answerSave(device, request, answer),
            answer !== "context_changed" && answer.status !== "stale"
              ? {
                  kind: "acknowledged",
                  request,
                  revs: revs as Record<string, number>,
                }
              : { kind: "other" },
          );
          inFlight[index] = null;
        } else if (roll < 0.65 && inFlight[index]) {
          step(
            index,
            saveFailed(device, inFlight[index]!.request.ticket, "network"),
          );
          inFlight[index] = null;
        } else if (roll < 0.78) {
          // A read whose answer is taken now, but may be delivered late.
          const [state, ticket] = startRead(device);
          step(index, state);
          reads[index]!.push({
            ticket,
            snapshot: server.read(sessions[index]!),
          });
        } else if (roll < 0.9 && reads[index]!.length > 0) {
          // A read answer, possibly an old one, possibly out of order.
          const at = Math.floor(random() * reads[index]!.length);
          const { ticket, snapshot } = reads[index]!.splice(at, 1)[0]!;
          const after =
            random() < 0.2
              ? readFailed(device, ticket)
              : readAnswered(device, ticket, snapshot);
          // A barrier is only ever cleared by a read sent after it.
          if (device.readAfter !== null && after.readAfter === null) {
            expect(ticket.generation).toBe(device.generation);
            expect(ticket.seq).toBeGreaterThanOrEqual(device.readAfter);
          }
          // Each new ambiguity moves the barrier forward, never back.
          if (
            after.generation === device.generation &&
            device.readAfter !== null &&
            after.readAfter !== null
          ) {
            expect(after.readAfter).toBeGreaterThanOrEqual(device.readAfter);
          }
          step(index, after);
        } else if (roll < 0.93) {
          // This device signs out and the other account signs in, or back.
          sessions[index] = sessions[index] === A ? B : A;
          step(index, enterContext(device, server.read(sessions[index]!)));
        } else if (roll < 0.95 && sessions[index] === A) {
          // She leaves the business and joins it again.
          server.leave(contexts[0]!);
          contexts[0] = server.join(A.userId, A.businessId);
        } else if (roll < 0.97) {
          // An administrator deletes the row (a new incarnation follows).
          server.dropRow(server.read(sessions[index]!).context);
        }
        for (const state of devices) {
          // What a device shows comes from its own context, never another's.
          const from = server.origin.get(state.observed);
          if (from) expect(from).toBe(state.context.membershipId);
        }
      }
      for (const index of [0, 1]) {
        if (inFlight[index]) {
          const { request, session } = inFlight[index]!;
          devices[index] = answerSave(
            devices[index]!,
            request,
            server.save(session, request),
          );
        }
        const session = sessions[index]!;
        if (
          sameContext(devices[index]!.context, server.read(session).context)
        ) {
          // Still in its context: a read resumes it, and every intent it
          // holds reaches the account.
          const wanted = unacknowledgedChanges(devices[index]!);
          devices[index] = flush(
            read(devices[index]!, server, session),
            server,
            session,
          );
          expect(server.read(session).preferences.appearance).toMatchObject(
            wanted,
          );
          expect(devices[index]!.intents).toEqual({});
        } else {
          // Its context is gone: the page reloads into the session's.
          devices[index] = enterContext(devices[index]!, server.read(session));
        }
        devices[index] = read(devices[index]!, server, session);
        // A stable account: no reconciliation read is due, none loops.
        const settledDevice = reconcile(devices[index]!, server, session);
        expect(settledDevice.reads).toBeLessThanOrEqual(1);
        devices[index] = settledDevice.state;
        expect(readNeeded(devices[index]!)).toBe(false);
        expect(displayedAppearance(devices[index]!)).toEqual(
          server.read(session).preferences.appearance,
        );
        expect(nextSave(devices[index]!)[1]).toBeNull();
      }
    }
  });
});

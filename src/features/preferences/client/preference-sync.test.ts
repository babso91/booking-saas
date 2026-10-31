import { describe, expect, it } from "vitest";

import {
  defaultAppearancePreferences,
  noMemberPreferences,
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
  nextSave,
  readAnswered,
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
    expect(device.confirmed.version).toBe(1);
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
    expect(after.inFlight).toEqual(second);
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
    expect(after.inFlight).toEqual(requestB);
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
    expect(device.confirmed).toEqual(noMemberPreferences);
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
    expect(device.confirmed).toEqual(noMemberPreferences);
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
    expect(device.confirmed).toEqual(noMemberPreferences);
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
    expect(device.confirmed.version).toBe(3);

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
      expect(device.confirmed).toEqual(noMemberPreferences);
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
    expect(laptop.confirmed.version).toBe(4);
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
    expect(recreated.confirmed).toMatchObject({ version: 1 });
    expect(recreated.confirmed.incarnation).not.toBe(
      laptop.confirmed.incarnation,
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
    // A late read of the old incarnation (sent before) never comes back.
    const [reading, ticket] = startRead(laptop);
    const newest = readAnswered(reading, ticket, server.read(A));
    expect(
      readAnswered(
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
      ),
    ).toEqual(newest);
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

describe("preference sync: random interleavings", () => {
  it("two devices and session changes: no answer crosses contexts, everything ends in step", () => {
    let seed = 11;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const colours = ["#000001", "#000002", "#000003", "#000004"];
    for (let run = 0; run < 300; run++) {
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
      for (let step = 0; step < 40; step++) {
        const index = random() < 0.5 ? 0 : 1;
        const roll = random();
        const device = devices[index]!;
        if (roll < 0.3) {
          devices[index] = changeLocally(device, {
            ...displayedAppearance(device),
            accent: colours[Math.floor(random() * colours.length)]!,
          });
        } else if (roll < 0.5 && !inFlight[index]) {
          const [state, request] = nextSave(device);
          devices[index] = state;
          if (request) inFlight[index] = { request, session: sessions[index]! };
        } else if (roll < 0.7 && inFlight[index]) {
          const { request, session } = inFlight[index]!;
          const answer = server.save(session, request);
          devices[index] = answerSave(devices[index]!, request, answer);
          inFlight[index] = null;
        } else if (roll < 0.75 && inFlight[index]) {
          devices[index] = saveFailed(
            device,
            inFlight[index]!.request.ticket,
            "network",
          );
          inFlight[index] = null;
        } else if (roll < 0.85) {
          const [state, ticket] = startRead(device);
          devices[index] = state;
          reads[index]!.push({
            ticket,
            snapshot: server.read(sessions[index]!),
          });
        } else if (roll < 0.92 && reads[index]!.length > 0) {
          // A read answer, possibly an old one, possibly out of order.
          const at = Math.floor(random() * reads[index]!.length);
          const { ticket, snapshot } = reads[index]!.splice(at, 1)[0]!;
          devices[index] = readAnswered(device, ticket, snapshot);
        } else if (roll < 0.95) {
          // This device signs out and the other account signs in, or back.
          sessions[index] = sessions[index] === A ? B : A;
          devices[index] = enterContext(device, server.read(sessions[index]!));
        } else if (roll < 0.97 && sessions[index] === A) {
          // She leaves the business and joins it again.
          server.leave(contexts[0]!);
          contexts[0] = server.join(A.userId, A.businessId);
        }
        for (const state of devices) {
          // What a device shows comes from its own context, never another's.
          const from = server.origin.get(state.confirmed);
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
        // The page reloads into its session's context, and settles.
        devices[index] = enterContext(
          devices[index]!,
          server.read(sessions[index]!),
        );
        devices[index] = flush(devices[index]!, server, sessions[index]!);
        expect(displayedAppearance(devices[index]!)).toEqual(
          server.read(sessions[index]!).preferences.appearance,
        );
        expect(nextSave(devices[index]!)[1]).toBeNull();
      }
    }
  });
});

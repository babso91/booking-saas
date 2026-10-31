import { describe, expect, it } from "vitest";

import {
  defaultAppearancePreferences,
  noMemberPreferences,
  type AppearancePreferences,
  type MemberPreferences,
} from "../model";
import {
  accountChanged,
  accountRead,
  changeLocally,
  displayedAppearance,
  initialSyncState,
  nextSave,
  saveAnswered,
  saveFailed,
  type SaveRequest,
  type SyncState,
} from "./preference-sync";

// A tiny account, as save_member_preferences behaves (tested against
// PostgreSQL in tests/integration/member-preferences.test.ts), to play
// devices against it.
class Account {
  state: MemberPreferences = noMemberPreferences;

  save(request: SaveRequest) {
    const next = { ...this.state.appearance, ...request.changes };
    const same = JSON.stringify(next) === JSON.stringify(this.state.appearance);
    if (same) return { status: "unchanged" as const, preferences: this.state };
    if (request.expectedVersion !== this.state.version) {
      return { status: "stale" as const, preferences: this.state };
    }
    this.state = { appearance: next, version: this.state.version + 1 };
    return { status: "saved" as const, preferences: this.state };
  }
}

const look = (
  patch: Partial<AppearancePreferences>,
): AppearancePreferences => ({
  ...defaultAppearancePreferences,
  ...patch,
});

/** Sends every pending save until the device is in step. */
function flush(device: SyncState, account: Account): SyncState {
  for (let round = 0; round < 10; round++) {
    const [sending, request] = nextSave(device);
    if (!request) return sending;
    device = saveAnswered(sending, account.save(request));
  }
  throw new Error("never settles");
}

describe("preference sync", () => {
  it("first account: the defaults; nothing to send until she changes something", () => {
    const device = initialSyncState(noMemberPreferences);
    expect(displayedAppearance(device)).toEqual(defaultAppearancePreferences);
    expect(nextSave(device)[1]).toBeNull();
  });

  it("Écrin on the laptop, found on the phone; a colour from the phone reaches the laptop", () => {
    const account = new Account();
    let laptop = initialSyncState(account.state);
    laptop = changeLocally(laptop, look({ style: "ecrin", mode: "dark" }));
    laptop = flush(laptop, account);
    expect(account.state.appearance).toMatchObject({
      style: "ecrin",
      mode: "dark",
    });

    let phone = initialSyncState(account.state);
    expect(displayedAppearance(phone)).toMatchObject({
      style: "ecrin",
      mode: "dark",
    });
    phone = changeLocally(phone, {
      ...displayedAppearance(phone),
      accent: "#2F6F5E",
    });
    phone = flush(phone, account);

    laptop = accountRead(laptop, account.state);
    expect(displayedAppearance(laptop)).toEqual(
      look({ style: "ecrin", mode: "dark", accent: "#2F6F5E" }),
    );
  });

  it("her choice is shown at once, before the account answers", () => {
    let device = initialSyncState(noMemberPreferences);
    device = changeLocally(device, look({ style: "studio" }));
    const [sending] = nextSave(device);
    expect(displayedAppearance(sending).style).toBe("studio");
  });

  it("one save at a time; what she changes meanwhile is sent after", () => {
    const account = new Account();
    let device = initialSyncState(account.state);
    device = changeLocally(device, look({ style: "studio" }));
    const [sending, first] = nextSave(device);
    expect(first).toEqual({ expectedVersion: 0, changes: { style: "studio" } });

    device = changeLocally(
      sending,
      look({ style: "studio", accent: "#112233" }),
    );
    expect(nextSave(device)[1]).toBeNull();
    device = saveAnswered(device, account.save(first!));
    const [, second] = nextSave(device);
    expect(second).toEqual({
      expectedVersion: 1,
      changes: { accent: "#112233" },
    });
  });

  it("she undoes a choice while it is being sent: her last choice wins", () => {
    const account = new Account();
    account.state = { appearance: look({ accent: "#AAAAAA" }), version: 3 };
    let device = initialSyncState(account.state);
    device = changeLocally(device, look({ accent: "#BBBBBB" }));
    const [sending, request] = nextSave(device);
    device = changeLocally(sending, look({ accent: "#AAAAAA" }));
    device = saveAnswered(device, account.save(request!));
    expect(account.state.appearance.accent).toBe("#BBBBBB");
    device = flush(device, account);
    expect(account.state.appearance.accent).toBe("#AAAAAA");
    expect(displayedAppearance(device).accent).toBe("#AAAAAA");
  });

  it("stale: another device saved first; her change is applied on the new version, the other device's kept", () => {
    const account = new Account();
    let laptop = initialSyncState(account.state);
    let phone = initialSyncState(account.state);
    phone = flush(changeLocally(phone, look({ mode: "dark" })), account);
    laptop = changeLocally(laptop, look({ ambiance: "sauge" }));
    const [sending, request] = nextSave(laptop);
    const answer = account.save(request!);
    expect(answer.status).toBe("stale");
    laptop = flush(saveAnswered(sending, answer), account);
    expect(account.state.appearance).toMatchObject({
      mode: "dark",
      ambiance: "sauge",
    });
    expect(displayedAppearance(laptop)).toEqual(account.state.appearance);
    expect(displayedAppearance(accountRead(phone, account.state))).toEqual(
      account.state.appearance,
    );
  });

  it("answers arriving late or out of order never bring an older appearance back", () => {
    let device = initialSyncState({
      appearance: look({ accent: "#000001" }),
      version: 1,
    });
    device = accountRead(device, {
      appearance: look({ accent: "#000003" }),
      version: 3,
    });
    device = accountRead(device, {
      appearance: look({ accent: "#000002" }),
      version: 2,
    });
    expect(displayedAppearance(device).accent).toBe("#000003");
    device = saveAnswered(device, {
      status: "unchanged",
      preferences: { appearance: look({ accent: "#000001" }), version: 1 },
    });
    expect(device.confirmed.version).toBe(3);
    expect(displayedAppearance(device).accent).toBe("#000003");
  });

  it("a saved answer overtaken by a newer read: the other device's later change stands", () => {
    const account = new Account();
    let laptop = initialSyncState(account.state);
    laptop = changeLocally(laptop, look({ accent: "#111111" }));
    const [sending, request] = nextSave(laptop);
    const answer = account.save(request!); // version 1, #111111
    account.save({ expectedVersion: 1, changes: { accent: "#222222" } }); // phone, v2
    laptop = accountRead(sending, account.state); // read v2 first
    laptop = saveAnswered(laptop, answer); // then the late answer (v1)
    expect(displayedAppearance(laptop).accent).toBe("#222222");
    expect(nextSave(laptop)[1]).toBeNull();
  });

  it("a read while her change is unsent does not erase her change", () => {
    let device = initialSyncState(noMemberPreferences);
    device = changeLocally(device, look({ motion: "none" }));
    device = accountRead(device, {
      appearance: look({ mode: "dark" }),
      version: 1,
    });
    expect(displayedAppearance(device)).toEqual(
      look({ mode: "dark", motion: "none" }),
    );
    expect(nextSave(device)[1]).toEqual({
      expectedVersion: 1,
      changes: { motion: "none" },
    });
  });

  it("network error or database away: nothing is lost, the same change is sent again", () => {
    const account = new Account();
    let device = initialSyncState(account.state);
    device = changeLocally(device, look({ style: "carnet" }));
    const [sending, request] = nextSave(device);
    device = saveFailed(sending);
    expect(displayedAppearance(device).style).toBe("carnet");
    expect(nextSave(device)[1]).toEqual(request);
    device = flush(device, account);
    expect(account.state.appearance.style).toBe("carnet");
  });

  it("an answer lost after the account saved: the retry is 'unchanged', and settles", () => {
    const account = new Account();
    let device = initialSyncState(account.state);
    device = changeLocally(device, look({ style: "studio" }));
    const [sending, request] = nextSave(device);
    account.save(request!); // saved, answer lost
    device = saveFailed(sending);
    const [again, retry] = nextSave(device);
    const answer = account.save(retry!);
    expect(answer.status).toBe("unchanged");
    device = saveAnswered(again, answer);
    expect(device.confirmed.version).toBe(1);
    expect(nextSave(device)[1]).toBeNull();
  });

  it("repeated identical writes send nothing", () => {
    const account = new Account();
    let device = flush(
      changeLocally(initialSyncState(account.state), look({ style: "studio" })),
      account,
    );
    for (let index = 0; index < 5; index++) {
      device = changeLocally(device, look({ style: "studio" }));
      expect(nextSave(device)[1]).toBeNull();
    }
    expect(account.state.version).toBe(1);
  });

  it("another account on the same device: nothing of the previous one is kept", () => {
    let device = initialSyncState({
      appearance: look({ style: "studio" }),
      version: 4,
    });
    device = changeLocally(
      device,
      look({ style: "studio", accent: "#123456" }),
    );
    device = accountChanged(noMemberPreferences);
    expect(displayedAppearance(device)).toEqual(defaultAppearancePreferences);
    expect(nextSave(device)[1]).toBeNull();
  });

  it("random interleavings of two devices always end in step with the account, nothing left to send", () => {
    let seed = 7;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const colours = ["#000001", "#000002", "#000003", "#000004"];
    for (let run = 0; run < 200; run++) {
      const account = new Account();
      const devices = [
        initialSyncState(account.state),
        initialSyncState(account.state),
      ];
      const inFlight: (SaveRequest | null)[] = [null, null];
      for (let step = 0; step < 30; step++) {
        const index = random() < 0.5 ? 0 : 1;
        const roll = random();
        if (roll < 0.35) {
          const accent = colours[Math.floor(random() * colours.length)]!;
          devices[index] = changeLocally(devices[index]!, {
            ...displayedAppearance(devices[index]!),
            accent,
          });
        } else if (roll < 0.6 && !inFlight[index]) {
          const [state, request] = nextSave(devices[index]!);
          devices[index] = state;
          inFlight[index] = request;
        } else if (roll < 0.85 && inFlight[index]) {
          devices[index] = saveAnswered(
            devices[index]!,
            account.save(inFlight[index]!),
          );
          inFlight[index] = null;
        } else if (roll < 0.9 && inFlight[index]) {
          devices[index] = saveFailed(devices[index]!);
          inFlight[index] = null;
        } else {
          devices[index] = accountRead(devices[index]!, account.state);
        }
      }
      for (const index of [0, 1]) {
        if (inFlight[index]) {
          devices[index] = saveAnswered(
            devices[index]!,
            account.save(inFlight[index]!),
          );
        }
        devices[index] = flush(devices[index]!, account);
      }
      for (const index of [0, 1]) {
        devices[index] = accountRead(devices[index]!, account.state);
        expect(displayedAppearance(devices[index]!)).toEqual(
          account.state.appearance,
        );
        expect(nextSave(devices[index]!)[1]).toBeNull();
      }
    }
  });
});

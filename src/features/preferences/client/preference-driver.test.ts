import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionResult } from "@/lib/errors";

import {
  defaultAppearancePreferences,
  type AppearanceChanges,
  importDeviceAppearanceSchema,
  savePreferencesSchema,
  type AppearancePreferences,
  type PreferenceContext,
  type PreferencesSnapshot,
} from "../model";
import {
  LAST_RETRY_MS,
  PreferenceDriver,
  REQUEST_TIMEOUT_MS,
} from "./preference-driver";
import { STALE_LIMIT, type SaveAnswer } from "./preference-sync";

// The driver with every answer held by the test and a fake clock: each race
// is played in the order written here, nothing is left to timing.

const uuid = (name: string) =>
  `00000000-0000-4000-8000-${name.padStart(12, "0")}`;
const context = (membershipId = "1", businessId = "b1") => ({
  userId: uuid("99"),
  businessId: uuid(businessId),
  membershipId: uuid(membershipId),
});
const onWire = ({ businessId, membershipId }: PreferenceContext) => ({
  businessId,
  membershipId,
});

const snapshot = (
  appearance: AppearanceChanges = {},
  version = 0,
  ctx = context(),
  incarnation: string | null = version ? uuid("a1") : null,
): PreferencesSnapshot => ({
  context: ctx,
  preferences: {
    incarnation,
    version,
    appearance: { ...defaultAppearancePreferences, ...appearance },
  },
});

type Held<T> = {
  input: unknown;
  answer: (data: T) => Promise<void>;
  refuse: (code: string) => Promise<void>;
  drop: () => Promise<void>;
};

function held<T>(input?: unknown) {
  let resolve!: (value: ActionResult<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ActionResult<T>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const entry: Held<T> = {
    input,
    answer: async (data) => {
      resolve({ ok: true, data });
      await vi.advanceTimersByTimeAsync(0);
    },
    refuse: async (code) => {
      resolve({ ok: false, error: { code, message: code } } as ActionResult<T>);
      await vi.advanceTimersByTimeAsync(0);
    },
    drop: async () => {
      reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(0);
    },
  };
  return { promise, entry };
}

function setup(first: PreferencesSnapshot | null = snapshot()) {
  const reads: Held<PreferencesSnapshot>[] = [];
  const saves: Held<SaveAnswer>[] = [];
  const imports: Held<SaveAnswer>[] = [];
  const refresh = vi.fn();
  let hidden = false;
  const driver = new PreferenceDriver(
    {
      snapshot: first,
      appearance: first?.preferences.appearance ?? {
        ...defaultAppearancePreferences,
        style: "studio",
      },
    },
    {
      read: () => {
        const { promise, entry } = held<PreferencesSnapshot>();
        reads.push(entry);
        return promise;
      },
      // What is sent is what the action accepts: its schema is strict.
      save: (input) => {
        savePreferencesSchema.parse(input);
        const { promise, entry } = held<SaveAnswer>(input);
        saves.push(entry);
        return promise;
      },
      importDevice: (input) => {
        importDeviceAppearanceSchema.parse(input);
        const { promise, entry } = held<SaveAnswer>(input);
        imports.push(entry);
        return promise;
      },
    },
    { refresh, isHidden: () => hidden },
  );
  driver.start();
  return {
    driver,
    reads,
    saves,
    imports,
    refresh,
    hide: (value: boolean) => {
      hidden = value;
    },
  };
}

const saved = (
  appearance: AppearanceChanges,
  version: number,
  status: SaveAnswer["status"] = "saved",
  ctx = context(),
): SaveAnswer => ({
  status,
  ...snapshot(appearance, version, ctx, uuid("a1")),
});

const sentChanges = (save: Held<SaveAnswer>) =>
  (save.input as { changes: Partial<AppearancePreferences> }).changes;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("saving", () => {
  it("applies at once, sends once, and is saved only when answered", async () => {
    const { driver, saves } = setup();
    driver.change({ style: "ecrin" });
    expect(driver.getView().appearance.style).toBe("ecrin");
    expect(driver.getView().status).toBe("saving");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.input).toEqual({
      context: onWire(context()),
      expected: { incarnation: null, version: 0 },
      changes: { style: "ecrin" },
    });

    await saves[0]!.answer(saved({ style: "ecrin" }, 1));
    expect(driver.getView()).toMatchObject({
      status: "idle",
      savedHere: true,
      accountHasPreferences: true,
    });
    expect(saves).toHaveLength(1);
  });

  it("one save at a time; the newest choice follows, none is lost", async () => {
    const { driver, saves } = setup();
    driver.change({ mode: "dark" });
    driver.change({ mode: "light", motion: "none" });
    driver.change({ accent: "#112233" });
    expect(saves).toHaveLength(1);
    expect(driver.getView().appearance).toMatchObject({
      mode: "light",
      motion: "none",
      accent: "#112233",
    });

    await saves[0]!.answer(saved({ mode: "dark" }, 1));
    expect(saves).toHaveLength(2);
    expect(sentChanges(saves[1]!)).toEqual({
      mode: "light",
      motion: "none",
      accent: "#112233",
    });
    expect(driver.getView().appearance.mode).toBe("light");
  });

  it("a field she did not touch stays what the account holds (Carnet)", async () => {
    const { driver, saves } = setup(snapshot({ style: "carnet" }, 3));
    driver.change({ mode: "dark" });
    expect(sentChanges(saves[0]!)).toEqual({ mode: "dark" });
    expect(driver.getView().appearance.style).toBe("carnet");
  });

  it("stale: sent again on the state it brought, her other tab's choice kept", async () => {
    const { driver, saves } = setup(snapshot({}, 1));
    driver.change({ mode: "dark" });
    await saves[0]!.answer(saved({ motion: "none" }, 2, "stale"));
    expect(saves).toHaveLength(2);
    expect(saves[1]!.input).toMatchObject({
      expected: { incarnation: uuid("a1"), version: 2 },
      changes: { mode: "dark" },
    });
    expect(driver.getView().appearance).toMatchObject({
      mode: "dark",
      motion: "none",
    });
  });

  it(`after ${STALE_LIMIT} stale answers it stops, then a read resumes it`, async () => {
    const { driver, saves, reads } = setup(snapshot({}, 1));
    driver.change({ mode: "dark" });
    for (let index = 0; index < STALE_LIMIT; index += 1) {
      await saves[index]!.answer(saved({}, index + 2, "stale"));
    }
    expect(saves).toHaveLength(STALE_LIMIT);
    expect(driver.getView().status).toBe("paused");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads).toHaveLength(1);
    await reads[0]!.answer(snapshot({}, 9, context(), uuid("a1")));
    expect(saves).toHaveLength(STALE_LIMIT + 1);
  });
});

describe("failures", () => {
  it("waits 1 s, 2 s, 4 s… up to 30 s, and starts over at the first success", async () => {
    const { driver, saves } = setup();
    driver.change({ mode: "dark" });
    const expectedWaits = [1, 2, 4, 8, 16, 30, 30];
    for (const [index, seconds] of expectedWaits.entries()) {
      await saves[index]!.drop();
      expect(driver.getView().status).toBe("retrying");
      await vi.advanceTimersByTimeAsync(seconds * 1_000 - 1);
      expect(saves).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(saves).toHaveLength(index + 2);
    }
    expect(expectedWaits.at(-1)! * 1_000).toBe(LAST_RETRY_MS);

    await saves.at(-1)!.answer(saved({ mode: "dark" }, 1));
    expect(driver.getView().status).toBe("idle");

    driver.change({ motion: "none" });
    await saves.at(-1)!.drop();
    const before = saves.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saves).toHaveLength(before + 1);
  });

  it("a server failure keeps her choice and sends it again", async () => {
    const { driver, saves } = setup();
    driver.change({ mode: "dark" });
    await saves[0]!.refuse("internal");
    expect(driver.getView().appearance.mode).toBe("dark");
    await vi.advanceTimersByTimeAsync(1_000);
    await saves[1]!.answer(saved({ mode: "dark" }, 1, "unchanged"));
    expect(driver.getView().status).toBe("idle");
  });

  it("a save that never answers times out; its late answer is dropped", async () => {
    const { driver, saves } = setup();
    driver.change({ mode: "dark" });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(driver.getView().status).toBe("retrying");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saves).toHaveLength(2);

    // The first one finally answers, with an older account.
    await saves[0]!.answer(saved({ mode: "light" }, 1));
    expect(driver.getView().status).toBe("retrying");
    expect(driver.getView().appearance.mode).toBe("dark");
    await saves[1]!.answer(saved({ mode: "dark" }, 2));
    expect(driver.getView().status).toBe("idle");
  });

  it("a refusal for the session pauses, keeps her choice, renders the layout once", async () => {
    const { driver, saves, reads, refresh } = setup();
    driver.change({ mode: "dark" });
    await saves[0]!.refuse("context_changed");
    expect(driver.getView().status).toBe("paused");
    expect(driver.getView().appearance.mode).toBe("dark");
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await reads[0]!.refuse("unauthenticated");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(saves).toHaveLength(1);

    // Back: the same context answers, her choice leaves.
    await reads[1]!.answer(snapshot());
    expect(saves).toHaveLength(2);
    expect(sentChanges(saves[1]!)).toEqual({ mode: "dark" });
  });

  it("unauthenticated may be an outage: paused, never sent to sign in by itself", async () => {
    const { driver, saves, reads, refresh } = setup();
    driver.change({ mode: "dark" });
    await saves[0]!.refuse("unauthenticated");
    expect(driver.getView()).toMatchObject({
      status: "paused",
      appearance: { mode: "dark" },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await reads[0]!.refuse("unauthenticated");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).not.toHaveBeenCalled();

    await reads[1]!.answer(snapshot());
    expect(sentChanges(saves[1]!)).toEqual({ mode: "dark" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["forbidden", "no_business"])(
    "%s: the server read the session, the layout can tell",
    async (code) => {
      const { driver, saves, refresh } = setup();
      driver.change({ mode: "dark" });
      await saves[0]!.refuse(code);
      expect(driver.getView().status).toBe("paused");
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );

  it("the read a navigation abandoned: timed out, a later one answers, its late answer is dropped", async () => {
    const { driver, reads } = setup();
    driver.returned();
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1_000);
    driver.returned();
    expect(reads).toHaveLength(2);
    await reads[0]!.answer(snapshot({ mode: "dark" }, 9));
    expect(driver.getView().appearance.mode).toBe("light");
    await reads[1]!.answer(snapshot({ mode: "system" }, 10));
    expect(driver.getView().appearance.mode).toBe("system");
  });
});

describe("a style received from elsewhere", () => {
  const from = async (
    { driver, reads }: ReturnType<typeof setup>,
    appearance: AppearanceChanges,
  ) => {
    driver.returned();
    await reads.at(-1)!.answer(snapshot(appearance, 3));
  };

  it("waits, while the other settings follow live", async () => {
    const page = setup();
    await from(page, { style: "ecrin", mode: "dark" });
    expect(page.driver.getView()).toMatchObject({
      appearance: { style: "classique", mode: "dark" },
      receivedStyle: "ecrin",
      status: "idle",
    });

    page.driver.applyReceivedStyle();
    expect(page.driver.getView()).toMatchObject({
      appearance: { style: "ecrin", mode: "dark" },
      receivedStyle: null,
    });
  });

  it("another setting while it waits does not write the style", async () => {
    const page = setup();
    await from(page, { style: "ecrin" });
    page.driver.change({ motion: "none" });
    expect(sentChanges(page.saves[0]!)).toEqual({ motion: "none" });
    expect(page.driver.getView().appearance.style).toBe("classique");
  });

  it("her own choice is drawn at once, and is the one kept", async () => {
    const page = setup();
    await from(page, { style: "ecrin" });
    page.driver.change({ style: "studio", accent: null });
    expect(page.driver.getView()).toMatchObject({
      appearance: { style: "studio" },
      receivedStyle: null,
    });
    expect(sentChanges(page.saves[0]!).style).toBe("studio");
  });

  it("goes away if her account comes back to what is shown", async () => {
    const page = setup();
    await from(page, { style: "ecrin" });
    await vi.advanceTimersByTimeAsync(1_000);
    page.driver.returned();
    await page.reads.at(-1)!.answer(snapshot({ style: "classique" }, 4));
    expect(page.driver.getView().receivedStyle).toBeNull();
  });

  it("another context is drawn at once: never the other account's frame", async () => {
    const page = setup();
    await from(page, { style: "ecrin" });
    page.driver.receiveArea({
      snapshot: snapshot({ style: "studio" }, 1, context("2")),
      appearance: { ...defaultAppearancePreferences, style: "studio" },
    });
    expect(page.driver.getView()).toMatchObject({
      appearance: { style: "studio" },
      receivedStyle: null,
    });
  });
});

describe("reads", () => {
  it("focus and visibilitychange together: one read", async () => {
    const { driver, reads } = setup();
    driver.returned();
    driver.returned();
    expect(reads).toHaveLength(1);
    await reads[0]!.answer(snapshot());
    driver.returned();
    expect(reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    driver.returned();
    expect(reads).toHaveLength(2);
  });

  it("a stale read after a recent choice changes nothing she chose", async () => {
    const { driver, reads, saves } = setup(snapshot({}, 1));
    driver.returned();
    driver.change({ style: "ecrin" });
    await saves[0]!.answer(saved({ style: "ecrin" }, 2));
    await reads[0]!.answer(
      snapshot({ style: "classique" }, 1, context(), uuid("a1")),
    );
    expect(driver.getView().appearance.style).toBe("ecrin");
  });

  it("a read never acknowledges: a choice in flight stays unsaved", async () => {
    const { driver, reads, saves } = setup(snapshot({}, 1));
    driver.change({ style: "ecrin" });
    driver.returned();
    await reads[0]!.answer(
      snapshot({ style: "ecrin" }, 2, context(), uuid("a1")),
    );
    expect(driver.getView().status).toBe("saving");
    await saves[0]!.answer(saved({ style: "ecrin" }, 2, "unchanged"));
    expect(driver.getView().status).toBe("idle");
  });

  it("a read stuck: timed out, settled once, the late answer is dropped", async () => {
    const { driver, reads } = setup(snapshot({}, 1));
    driver.returned();
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await reads[0]!.answer(
      snapshot({ style: "studio" }, 8, context(), uuid("a1")),
    );
    expect(driver.getView().appearance.style).toBe("classique");

    await vi.advanceTimersByTimeAsync(1_000);
    driver.returned();
    await reads[1]!.answer(
      snapshot({ style: "ecrin" }, 9, context(), uuid("a1")),
    );
    expect(driver.getView().receivedStyle).toBe("ecrin");
  });

  it("an answer it could not order asks for one more read, and only one", async () => {
    const { driver, reads, saves } = setup(
      snapshot({}, 1, context(), uuid("a1")),
    );
    driver.returned();
    const lateRead = reads[0]!;
    driver.change({ mode: "dark" });
    // The row was recreated: the save, sent after the read, brings the new one.
    await saves[0]!.answer({
      status: "saved",
      ...snapshot({ mode: "dark" }, 1, context(), uuid("a2")),
    });
    // The read, sent earlier, answers the old row: it cannot be ordered.
    await lateRead.answer(
      snapshot({ motion: "none" }, 4, context(), uuid("a1")),
    );
    expect(reads).toHaveLength(2);
    await reads[1]!.answer(
      snapshot({ mode: "dark" }, 1, context(), uuid("a2")),
    );
    expect(reads).toHaveLength(2);
    expect(driver.getView().appearance.motion).toBe("standard");
  });

  it("a hidden tab does not read; its return does", async () => {
    const { driver, reads, hide } = setup(null);
    expect(reads).toHaveLength(1);
    await reads[0]!.drop();
    hide(true);
    await vi.advanceTimersByTimeAsync(LAST_RETRY_MS);
    expect(reads).toHaveLength(1);
    hide(false);
    driver.returned();
    expect(reads).toHaveLength(2);
  });
});

describe("renders of the layout", () => {
  it("the same context: nothing changes, nothing is erased, nothing is read", async () => {
    const { driver, saves, reads } = setup(snapshot({}, 1));
    driver.change({ style: "ecrin" });
    // router.refresh() during the save, with the account as it was.
    driver.receiveArea({
      snapshot: snapshot({ style: "studio" }, 1),
      appearance: defaultAppearancePreferences,
    });
    expect(driver.getView().appearance.style).toBe("ecrin");
    expect(driver.getView().status).toBe("saving");
    expect(saves).toHaveLength(1);
    expect(reads).toHaveLength(0);
    await saves[0]!.answer(saved({ style: "ecrin" }, 2));
    expect(driver.getView().status).toBe("idle");
  });

  it("a render without the database does not lose the context", () => {
    const { driver } = setup(snapshot({ style: "studio" }, 1));
    driver.receiveArea({
      snapshot: null,
      appearance: defaultAppearancePreferences,
    });
    expect(driver.getView().appearance.style).toBe("studio");
    expect(driver.getView().status).toBe("idle");
  });

  it.each([
    ["another business", context("2", "b2")],
    ["left and joined again", context("9")],
  ])(
    "%s, with a save and a read on their way: they are forgotten",
    async (_, next) => {
      const { driver, saves, reads } = setup(snapshot({ mode: "dark" }, 4));
      driver.returned();
      driver.change({ style: "ecrin" });
      driver.receiveArea({
        snapshot: snapshot({ style: "studio" }, 2, next, uuid("a7")),
        appearance: defaultAppearancePreferences,
      });
      expect(driver.getView()).toMatchObject({
        status: "idle",
        appearance: { style: "studio", mode: "light" },
      });

      await saves[0]!.answer(saved({ style: "ecrin" }, 5));
      await reads[0]!.answer(snapshot({ style: "ecrin", mode: "dark" }, 5));
      expect(driver.getView().appearance.style).toBe("studio");
      expect(driver.getView().savedHere).toBe(false);

      // Nothing of the old context is sent to the new one.
      driver.change({ motion: "none" });
      expect(saves).toHaveLength(2);
      expect(saves[1]!.input).toEqual({
        context: onWire(next),
        expected: { incarnation: uuid("a7"), version: 2 },
        changes: { motion: "none" },
      });
    },
  );

  it("a wait of the old context does not act in the new one", async () => {
    const { driver, saves } = setup();
    driver.change({ mode: "dark" });
    await saves[0]!.drop();
    driver.receiveArea({
      snapshot: snapshot({}, 1, context("2", "b2")),
      appearance: defaultAppearancePreferences,
    });
    await vi.advanceTimersByTimeAsync(LAST_RETRY_MS);
    expect(saves).toHaveLength(1);
  });

  it("an answer for another context, session changed under the page: paused", async () => {
    const { driver, saves, refresh } = setup();
    driver.change({ mode: "dark" });
    await saves[0]!.answer(saved({}, 1, "saved", context("2", "b2")));
    expect(driver.getView().status).toBe("paused");
    expect(driver.getView().appearance.mode).toBe("dark");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("the account could not be read", () => {
  it("shows the fallback, saves nothing, and starts from the first read answered", async () => {
    const { driver, reads, saves } = setup(null);
    expect(driver.getView()).toMatchObject({
      status: "unavailable",
      appearance: { style: "studio" },
    });
    driver.change({ mode: "dark" });
    expect(driver.getView().appearance.mode).toBe("light");
    expect(saves).toHaveLength(0);

    await reads[0]!.refuse("internal");
    expect(driver.getView().status).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(1_000);
    await reads[1]!.answer(snapshot({ style: "ecrin" }, 2));
    expect(driver.getView()).toMatchObject({
      status: "idle",
      appearance: { style: "studio" },
      receivedStyle: "ecrin",
    });
    driver.change({ mode: "dark" });
    expect(saves[0]!.input).toMatchObject({
      expected: { version: 2 },
      changes: { mode: "dark" },
    });
  });

  it("a render that brings the account wins over a read still on its way", async () => {
    const { driver, reads } = setup(null);
    driver.receiveArea({
      snapshot: snapshot({ style: "ecrin" }, 2),
      appearance: defaultAppearancePreferences,
    });
    await reads[0]!.answer(snapshot({ style: "studio" }, 1));
    expect(driver.getView().receivedStyle).toBe("ecrin");
  });
});

describe("an old device's look", () => {
  const look = { ...defaultAppearancePreferences, style: "ecrin" as const };

  it("kept: sent for this context; shown from a read sent after it", async () => {
    const { driver, imports, reads } = setup();
    const settled = driver.importDevice(look);
    expect(driver.getView().importing).toBe("sending");
    expect(imports[0]!.input).toEqual({
      context: onWire(context()),
      appearance: look,
    });
    await imports[0]!.answer(saved({ style: "ecrin" }, 1));
    await expect(settled).resolves.toBe(true);
    expect(reads).toHaveLength(1);
    await reads[0]!.answer(
      snapshot({ style: "ecrin" }, 1, context(), uuid("a1")),
    );
    expect(driver.getView()).toMatchObject({
      appearance: { style: "ecrin" },
      accountHasPreferences: true,
    });
  });

  it("the account has its own: they stay", async () => {
    const { driver, imports, reads } = setup();
    const settled = driver.importDevice(look);
    await imports[0]!.answer(saved({ style: "studio" }, 3, "stale"));
    await expect(settled).resolves.toBe(true);
    await reads[0]!.answer(
      snapshot({ style: "studio" }, 3, context(), uuid("a1")),
    );
    expect(driver.getView().appearance.style).toBe("studio");
  });

  it("no answer: the question stays open, nothing changes", async () => {
    const { driver } = setup();
    const settled = driver.importDevice(look);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await expect(settled).resolves.toBe(false);
    expect(driver.getView()).toMatchObject({
      importing: "failed",
      appearance: { style: "classique" },
    });
  });
});

describe("after the page is gone", () => {
  it("no wait fires, nothing is sent", async () => {
    const { driver, saves, reads } = setup();
    driver.change({ mode: "dark" });
    await saves[0]!.drop();
    driver.stop();
    await vi.advanceTimersByTimeAsync(LAST_RETRY_MS);
    expect(saves).toHaveLength(1);
    expect(reads).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("started again (Strict Mode): sends what was due, once", async () => {
    const { driver, saves } = setup();
    driver.change({ mode: "dark" });
    driver.stop();
    driver.start();
    expect(saves).toHaveLength(1);
    await saves[0]!.drop();
    driver.stop();
    driver.start();
    expect(saves).toHaveLength(2);
  });
});

// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoyaltyScope, NewOperation } from "./operation-store";

// The durable store of uncertain loyalty operations, as several tabs use
// it: each "tab" is its own module instance with its own connection to the
// same database (a spec-compliant IndexedDB: readwrite transactions of all
// connections run one after the other, unique indexes are enforced).

type Store = typeof import("./operation-store");

async function tab(): Promise<Store> {
  vi.resetModules();
  return import("./operation-store");
}

const scope: LoyaltyScope = {
  userId: "user-a",
  businessId: "business-a",
  clientId: "20000000-0000-4000-8000-000000000001",
};
const credit = (points: number, reason = "Geste"): NewOperation => ({
  kind: "credit",
  command: { clientId: scope.clientId, pointsDelta: points, reason },
});

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("concurrent tabs", () => {
  it("A: two tabs creating the same operation at once get one identity", async () => {
    const [one, two] = [await tab(), await tab()];
    const [a, b] = await Promise.all([
      one.recordOperation(scope, credit(10)),
      two.recordOperation(scope, credit(10)),
    ]);
    expect(a.requestId).toBe(b.requestId);
    expect(await one.listOperations(scope)).toHaveLength(1);
  });

  it("B: two independent operations recorded at once both stay", async () => {
    const [one, two] = [await tab(), await tab()];
    const [a, b] = await Promise.all([
      one.recordOperation(scope, credit(10)),
      two.recordOperation(scope, credit(20)),
    ]);
    expect(a.requestId).not.toBe(b.requestId);
    const ids = (await two.listOperations(scope)).map((item) => item.requestId);
    expect(ids.sort()).toEqual([a.requestId, b.requestId].sort());
  });

  it("C/G/I: resolving A while B is recorded removes A only; A's content later gets a new id", async () => {
    const [one, two] = [await tab(), await tab()];
    const a = await one.recordOperation(scope, credit(10));
    const [, b] = await Promise.all([
      one.resolveOperation(a.requestId),
      two.recordOperation(scope, credit(20)),
    ]);
    const left = await one.listOperations(scope);
    expect(left.map((item) => item.requestId)).toEqual([b.requestId]);
    // A late (repeated) answer for A removes nothing else.
    await two.resolveOperation(a.requestId);
    expect(
      (await one.listOperations(scope)).map((item) => item.requestId),
    ).toEqual([b.requestId]);
    // A distinct operation after resolution: a new identity.
    const again = await one.recordOperation(scope, credit(10));
    expect(again.requestId).not.toBe(a.requestId);
  });

  it("many tabs, many operations, interleaved: every distinct content kept exactly once", async () => {
    const tabs = await Promise.all([tab(), tab(), tab()].map((item) => item));
    const contents = [1, 2, 3, 4, 5, 6];
    const results = await Promise.all(
      contents.flatMap((points) =>
        tabs.map((store) => store.recordOperation(scope, credit(points))),
      ),
    );
    const byContent = new Map<number, Set<string>>();
    results.forEach((result) => {
      const points = (result.command as { pointsDelta: number }).pointsDelta;
      byContent.set(
        points,
        (byContent.get(points) ?? new Set()).add(result.requestId),
      );
    });
    contents.forEach((points) => expect(byContent.get(points)!.size).toBe(1));
    expect(await tabs[0]!.listOperations(scope)).toHaveLength(contents.length);
  });

  it("H: a requestId is never reused with another payload", async () => {
    const store = await tab();
    const first = await store.recordOperation(scope, credit(10, "A"));
    const other = await store.recordOperation(scope, credit(10, "B"));
    const redeem = await store.recordOperation(scope, {
      kind: "redeem",
      command: {
        clientId: scope.clientId,
        rewardId: "40000000-0000-4000-8000-000000000001",
      },
      label: { rewardName: "Remise", pointsRequired: 10 },
    });
    expect(
      new Set([first.requestId, other.requestId, redeem.requestId]).size,
    ).toBe(3);
    const stored = await store.listOperations(scope);
    expect(
      stored.find((item) => item.requestId === first.requestId)!.command,
    ).toEqual(credit(10, "A").command);
  });

  it("the schema itself refuses a second open record for the same content", async () => {
    const store = await tab();
    const a = await store.recordOperation(scope, credit(10));
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = globalThis.indexedDB.open(store.DB_NAME);
      request.onsuccess = () => resolve(request.result);
    });
    const outcome = await new Promise<string>((resolve) => {
      const tx = db.transaction("pending-operations", "readwrite");
      const raw = tx.objectStore("pending-operations");
      raw.get(a.requestId).onsuccess = (event) => {
        const row = (event.target as IDBRequest).result;
        raw.add({ ...row, requestId: "another-id" });
      };
      tx.oncomplete = () => resolve("committed");
      tx.onabort = () => resolve(tx.error?.name ?? "aborted");
    });
    db.close();
    expect(outcome).toBe("ConstraintError");
  });

  it("isolates users, businesses and customers", async () => {
    const store = await tab();
    await store.recordOperation(scope, credit(10));
    for (const other of [
      { ...scope, userId: "user-b" },
      { ...scope, businessId: "business-b" },
      { ...scope, clientId: "20000000-0000-4000-8000-000000000002" },
    ]) {
      expect(await store.listOperations(other)).toEqual([]);
      // The same content elsewhere is another operation.
      const there = await store.recordOperation(other, credit(10));
      expect(there.userId).toBe(other.userId);
    }
    expect(await store.listOperations(scope)).toHaveLength(1);
  });

  it("hiding keeps the identity; the same content shows it again", async () => {
    const store = await tab();
    const a = await store.recordOperation(scope, credit(10));
    await store.hideOperation(a.requestId);
    expect((await store.listOperations(scope))[0]!.state).toBe("hidden");
    const again = await store.recordOperation(scope, credit(10));
    expect(again.requestId).toBe(a.requestId);
    expect(again.state).toBe("open");
  });

  it("survives a full reload (new module, new connection)", async () => {
    const a = await (await tab()).recordOperation(scope, credit(10));
    const reloaded = await tab();
    expect(
      (await reloaded.listOperations(scope)).map((item) => item.requestId),
    ).toEqual([a.requestId]);
  });
});

describe("storage failures: nothing is reported recorded", () => {
  const quota = () => new DOMException("full", "QuotaExceededError");

  it("E: quota exceeded on add", async () => {
    const store = await tab();
    const { IDBObjectStore: FDBObjectStore } = await import("fake-indexeddb");
    vi.spyOn(FDBObjectStore.prototype, "add").mockImplementation(() => {
      throw quota();
    });
    await expect(
      store.recordOperation(scope, credit(10)),
    ).rejects.toBeInstanceOf(store.OperationStoreError);
    vi.restoreAllMocks();
    expect(await store.listOperations(scope)).toEqual([]);
  });

  it("transaction aborted after the write was accepted (only `complete` counts)", async () => {
    const store = await tab();
    const { IDBObjectStore: FDBObjectStore } = await import("fake-indexeddb");
    const add = FDBObjectStore.prototype.add;
    vi.spyOn(FDBObjectStore.prototype, "add").mockImplementation(function (
      this: InstanceType<typeof FDBObjectStore>,
      ...args: Parameters<typeof add>
    ) {
      const request = add.apply(this, args);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(
      store.recordOperation(scope, credit(10)),
    ).rejects.toBeInstanceOf(store.OperationStoreError);
    vi.restoreAllMocks();
    expect(await store.listOperations(scope)).toEqual([]);
  });

  it("IndexedDB unavailable", async () => {
    const store = await tab();
    Reflect.deleteProperty(globalThis, "indexedDB");
    await expect(
      store.recordOperation(scope, credit(10)),
    ).rejects.toBeInstanceOf(store.OperationStoreError);
    await expect(store.listOperations(scope)).rejects.toBeInstanceOf(
      store.OperationStoreError,
    );
  });

  it("opening fails, then works on the next attempt (a failure is not cached)", async () => {
    const store = await tab();
    const factory = globalThis.indexedDB;
    const open = factory.open.bind(factory);
    let failures = 1;
    vi.spyOn(factory, "open").mockImplementation((...args) => {
      if (failures-- > 0) throw new DOMException("denied", "SecurityError");
      return open(...args);
    });
    await expect(
      store.recordOperation(scope, credit(10)),
    ).rejects.toBeInstanceOf(store.OperationStoreError);
    const recorded = await store.recordOperation(scope, credit(10));
    expect(recorded.requestId).toBeTruthy();
  });
});

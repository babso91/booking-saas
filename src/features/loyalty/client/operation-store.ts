// Durable, cross-tab store of loyalty operations whose outcome is not known
// yet (issue a reward, credit or debit points). IndexedDB, one record per
// operation, every change in one readwrite transaction:
//
// - Atomic across tabs: IndexedDB runs readwrite transactions on the same
//   object store one after the other, for every connection of the origin
//   (all tabs). "Find the open operation with this content, or create it"
//   is one transaction, so two tabs creating the same operation at once get
//   the same requestId; a unique index on (scope, content) refuses a second
//   open record for the same content even so.
// - No global rewrite: a record is added, updated or deleted by its own key
//   (the requestId). Resolving one operation can never remove another.
// - Durable before use: a write is reported only once its transaction has
//   *completed* (`complete` event, `durability: "strict"` where supported).
//   Any failure (quota, storage unavailable, blocked, aborted transaction,
//   failed upgrade) is an error: callers must not send the request.
//
// Notifications between tabs (BroadcastChannel) only tell the screens to
// read again; they never carry or decide data.

export type LoyaltyScope = {
  userId: string;
  businessId: string;
  clientId: string;
};

export type RedeemCommand = { clientId: string; rewardId: string };
export type AdjustCommand = {
  clientId: string;
  pointsDelta: number;
  reason: string;
};

export type NewOperation =
  | {
      kind: "redeem";
      command: RedeemCommand;
      /** For display only (the reward as chosen). */
      label: { rewardName: string; pointsRequired: number };
    }
  | { kind: "credit" | "debit"; command: AdjustCommand };

export type PendingOperation = NewOperation & {
  requestId: string;
  /** Deterministic fingerprint of the kind and the business payload. */
  fingerprint: string;
  userId: string;
  businessId: string;
  clientId: string;
  /** `open`: shown as unconfirmed; `hidden`: alert dismissed, still kept. */
  state: "open" | "hidden";
  createdAt: string;
};

type StoredOperation = PendingOperation & {
  /** user:business:client */
  scope: string;
  /** scope|fingerprint: unique among unresolved operations. */
  openKey: string;
};

/** The operation could not be recorded (or read): nothing may be sent. */
export class OperationStoreError extends Error {
  constructor(cause: unknown) {
    super("loyalty operation store unavailable", { cause });
    this.name = "OperationStoreError";
  }
}

export const DB_NAME = "booking-loyalty";
const DB_VERSION = 1;
const STORE = "pending-operations";
const CHANNEL = "booking-loyalty-pending";

export const scopeOf = (scope: LoyaltyScope) =>
  `${scope.userId}:${scope.businessId}:${scope.clientId}`;

/** Stable JSON of a value (sorted keys). */
export function fingerprintOf(value: unknown): string {
  return JSON.stringify(value, (_, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );
}

// One connection per IndexedDB factory (the page's, or a test's).
let connection: { factory: IDBFactory; db: Promise<IDBDatabase> } | null = null;

function factory(): IDBFactory {
  const found = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!found) throw new OperationStoreError(new Error("no IndexedDB"));
  return found;
}

function openDatabase(): Promise<IDBDatabase> {
  const current = factory();
  if (connection?.factory === current) return connection.db;
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = current.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(new OperationStoreError(error));
      return;
    }
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, {
        keyPath: "requestId",
      });
      store.createIndex("scope", "scope", { unique: false });
      store.createIndex("open", "openKey", { unique: true });
    };
    request.onsuccess = () => {
      const opened = request.result;
      // Another tab upgrades the schema: let it, reconnect on next use.
      opened.onversionchange = () => {
        opened.close();
        if (connection?.factory === current) connection = null;
      };
      resolve(opened);
    };
    request.onerror = () => reject(new OperationStoreError(request.error));
    request.onblocked = () =>
      reject(new OperationStoreError(new Error("database blocked")));
  });
  connection = { factory: current, db };
  // A failed open is not cached: the next use tries again.
  db.catch(() => {
    if (connection?.db === db) connection = null;
  });
  return db;
}

/**
 * Runs `work` in one transaction and resolves with its result only once the
 * transaction has completed (committed). Rejects with OperationStoreError
 * on any failure, including an abort after `work` ran.
 */
async function transaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let result: { value: T } | null = null;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(
        STORE,
        mode,
        mode === "readwrite" ? { durability: "strict" } : undefined,
      );
    } catch (error) {
      reject(new OperationStoreError(error));
      return;
    }
    tx.oncomplete = () => {
      if (result) resolve(result.value);
      else reject(new OperationStoreError(new Error("no result")));
    };
    tx.onerror = () => reject(new OperationStoreError(tx.error));
    tx.onabort = () =>
      reject(new OperationStoreError(tx.error ?? new Error("aborted")));
    try {
      work(tx.objectStore(STORE), (value) => {
        result = { value };
      });
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Already finished.
      }
      reject(new OperationStoreError(error));
    }
  });
}

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

/** The tab's channel, created on first use (to tell or to listen). */
function broadcast(): BroadcastChannel | null {
  if (!channel && typeof BroadcastChannel === "function") {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => listeners.forEach((listener) => listener());
  }
  return channel;
}

function notify() {
  listeners.forEach((listener) => listener());
  try {
    broadcast()?.postMessage("changed");
  } catch {
    // The other tabs read again when they become visible anyway.
  }
}

/** Store changes, in this tab or another one. */
export function subscribeOperations(listener: () => void) {
  listeners.add(listener);
  broadcast();
  const onVisible = () => {
    if (document.visibilityState === "visible") listener();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    listeners.delete(listener);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** The operation without its storage-only fields. */
function strip(row: StoredOperation): PendingOperation {
  const operation: Partial<StoredOperation> = { ...row };
  delete operation.scope;
  delete operation.openKey;
  return operation as PendingOperation;
}

/**
 * The unresolved operation with this content in this scope, or a new one,
 * in a single readwrite transaction, resolved only once committed. A hidden
 * one is shown again (the professional is retrying it).
 */
export async function recordOperation(
  scope: LoyaltyScope,
  operation: NewOperation,
): Promise<PendingOperation> {
  const scoped = scopeOf(scope);
  const fingerprint = fingerprintOf({
    kind: operation.kind,
    command: operation.command,
  });
  const openKey = `${scoped}|${fingerprint}`;
  const recorded = await transaction<StoredOperation>(
    "readwrite",
    (store, done) => {
      const lookup = store.index("open").get(openKey);
      lookup.onsuccess = () => {
        const existing = lookup.result as StoredOperation | undefined;
        if (existing) {
          const shown = { ...existing, state: "open" as const };
          if (existing.state !== "open") store.put(shown);
          done(shown);
          return;
        }
        const created: StoredOperation = {
          ...operation,
          requestId: crypto.randomUUID(),
          fingerprint,
          userId: scope.userId,
          businessId: scope.businessId,
          clientId: scope.clientId,
          state: "open",
          createdAt: new Date().toISOString(),
          scope: scoped,
          openKey,
        } as StoredOperation;
        // `add`, not `put`: never overwrites (the unique index guards too).
        store.add(created);
        done(created);
      };
    },
  );
  notify();
  return strip(recorded);
}

/** The scope's unresolved operations, oldest first. */
export async function listOperations(
  scope: LoyaltyScope,
): Promise<PendingOperation[]> {
  const rows = await transaction<StoredOperation[]>(
    "readonly",
    (store, done) => {
      const request = store.index("scope").getAll(scopeOf(scope));
      request.onsuccess = () => done(request.result as StoredOperation[]);
    },
  );
  return rows
    .filter((row) => row.clientId === scope.clientId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(strip);
}

/** Removes exactly this operation (resolved), by its own key. */
export async function resolveOperation(requestId: string) {
  await transaction<true>("readwrite", (store, done) => {
    store.delete(requestId);
    done(true);
  });
  notify();
}

/** Hides the alert of this operation; its identity is kept for any retry. */
export async function hideOperation(requestId: string) {
  await transaction<true>("readwrite", (store, done) => {
    const request = store.get(requestId);
    request.onsuccess = () => {
      const row = request.result as StoredOperation | undefined;
      if (row && row.state !== "hidden") store.put({ ...row, state: "hidden" });
      done(true);
    };
  });
  notify();
}

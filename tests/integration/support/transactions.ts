import type pg from "pg";

import { db } from "./fixtures";

// Helpers to build deterministic interleavings of concurrent transactions.

export type OpenTransaction = { connection: pg.PoolClient; pid: number };

/**
 * Opens a transaction on its own connection (READ COMMITTED unless
 * `isolation` says otherwise). `role` switches to an API role
 * for the rest of the transaction; `userId` sets the JWT subject so that
 * auth.uid() and RLS behave as for a signed-in professional.
 */
export async function openTransaction(
  options: {
    role?: "anon" | "authenticated";
    userId?: string;
    isolation?: "read committed" | "repeatable read" | "serializable";
  } = {},
): Promise<OpenTransaction> {
  const connection = await db.connect();
  const { rows } = await connection.query<{ pid: number }>(
    "select pg_backend_pid() as pid",
  );

  await connection.query(
    `begin isolation level ${options.isolation ?? "read committed"}`,
  );

  if (options.userId) {
    await connection.query(
      "select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: options.userId, role: "authenticated" })],
    );
  }
  if (options.role) {
    await connection.query(`set local role ${options.role}`);
  }

  return { connection, pid: rows[0]!.pid };
}

export async function closeTransaction(
  transaction: OpenTransaction,
  action: "commit" | "rollback",
) {
  try {
    await transaction.connection.query(action);
  } finally {
    transaction.connection.release();
  }
}

/** Resolves once backend `pid` is waiting on a lock held by another transaction. */
export async function waitUntilBlocked(pid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await db.query(
      `select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`,
      [pid],
    );

    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Backend ${pid} never blocked on a lock`);
}

/** Settles a pending query into "ok" or its error message, never rejecting. */
export function outcome(query: Promise<unknown>) {
  return query.then(
    () => "ok",
    (error: { message: string }) => error.message,
  );
}

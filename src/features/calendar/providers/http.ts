import { CalendarProviderError } from "./types";

// Bounded HTTP calls to a calendar provider: per-attempt timeout, at most
// `retries` retries with exponential backoff and jitter for retryable
// failures (429, 5xx, timeout, network), Retry-After honoured up to a cap.
// An optional deadline (epoch ms) bounds the whole call, retries included:
// each attempt's timeout is cut to the remaining time and no backoff sleeps
// past it, so a sync pass can never outlive its lease.

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type RetryPolicy = {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
};

export const defaultRetryPolicy: RetryPolicy = {
  retries: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
  timeoutMs: 10_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Options of one provider call. */
export type CallOptions = {
  /** Absolute deadline (epoch ms) of the operation the call belongs to. */
  deadline?: number;
};

export function deadlineExceeded() {
  return new CalendarProviderError("unavailable", null, "Deadline exceeded");
}

/**
 * Runs an operation within a deadline (epoch ms). Already expired: the
 * operation is never started. Expiring meanwhile: the operation's signal is
 * aborted and the caller gets `deadlineExceeded`, while the operation's own
 * late answer or failure is still consumed (never an unhandled rejection).
 * Aborting is a courtesy to the remote side; whatever was already sent must
 * be made harmless by the callee (compare-and-set, deadlines in SQL).
 */
export function withDeadline<T>(
  deadline: number | undefined,
  run: (signal: AbortSignal | undefined) => PromiseLike<T>,
): Promise<T> {
  if (deadline === undefined) return Promise.resolve(run(undefined));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(deadlineExceeded());

  const controller = new AbortController();
  const operation = Promise.resolve(run(controller.signal));
  operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(deadlineExceeded());
      }, remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** What a run bounded by `withinDeadline` came to. */
export type DeadlineOutcome<T> =
  | { expired: false; value: T }
  /** The deadline came first: the run's signal was aborted. */
  | { expired: true };

/**
 * Runs an operation within a deadline (epoch ms) and says which came first,
 * explicitly: never inferred from the clock when the outcome is read.
 *
 * - the deadline first: the run's signal is aborted and the outcome is
 *   `{ expired: true }` (also when the timer fires a little before
 *   Date.now() reads the deadline). The run's late answer or failure is
 *   consumed, never an unhandled rejection;
 * - the run first: its value (`{ expired: false }`), or its own error,
 *   rejected unchanged, however late the caller looks at it;
 * - already expired: the run is never started.
 */
export function withinDeadline<T>(
  deadline: number,
  run: (signal: AbortSignal) => PromiseLike<T>,
): Promise<DeadlineOutcome<T>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve({ expired: true });

  const controller = new AbortController();
  let operation: Promise<T>;
  try {
    operation = Promise.resolve(run(controller.signal));
  } catch (error) {
    operation = Promise.reject(error);
  }
  operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation.then((value) => ({ expired: false as const, value })),
    new Promise<{ expired: true }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ expired: true });
      }, remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

function delayFor(
  attempt: number,
  policy: RetryPolicy,
  retryAfter: string | null,
) {
  const fromHeader = retryAfter ? Number(retryAfter) * 1000 : NaN;
  const backoff = policy.baseDelayMs * 2 ** attempt;
  const base =
    Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : backoff;
  return Math.min(policy.maxDelayMs, base) * (0.75 + Math.random() * 0.5);
}

/**
 * Sends a request, retrying retryable failures. Resolves with the final
 * response (any status); rejects with `unavailable` / `rate_limited` only
 * when every attempt failed that way.
 */
export async function sendWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  policy: RetryPolicy = defaultRetryPolicy,
  options: CallOptions = {},
): Promise<Response> {
  let lastStatus: number | null = null;
  const remaining = () =>
    options.deadline === undefined
      ? Number.POSITIVE_INFINITY
      : options.deadline - Date.now();

  for (let attempt = 0; attempt <= policy.retries; attempt += 1) {
    const budget = remaining();
    if (budget <= 0) throw deadlineExceeded();

    let response: Response | null = null;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(Math.min(policy.timeoutMs, budget)),
      });
    } catch {
      response = null; // network error or timeout
    }

    if (response && !isRetryableStatus(response.status)) {
      return response;
    }

    lastStatus = response?.status ?? null;
    if (attempt === policy.retries) break;
    await response?.body?.cancel().catch(() => undefined);
    const delay = delayFor(
      attempt,
      policy,
      response?.headers.get("retry-after") ?? null,
    );
    // No retry that could only start after the deadline.
    if (delay >= remaining()) break;
    await policy.sleep(delay);
  }

  throw new CalendarProviderError(
    lastStatus === 429 ? "rate_limited" : "unavailable",
    lastStatus,
    `Provider unavailable after ${policy.retries + 1} attempts`,
  );
}

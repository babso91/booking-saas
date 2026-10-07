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

/**
 * The operation's own deadline came first. Its identity, never the clock
 * when an error is examined, tells a deadline from a real failure. Still an
 * `unavailable` provider error for callers that only retry.
 */
export class DeadlineExceededError extends CalendarProviderError {
  constructor() {
    super("unavailable", null, "Deadline exceeded");
    this.name = "DeadlineExceededError";
  }
}

export function deadlineExceeded() {
  return new DeadlineExceededError();
}

/**
 * Responses whose request was bounded by its deadline: the abort signal
 * our deadline-capped timeout owns, so that reading the body can tell the
 * same cut from a real failure (see `isDeadlineCut`).
 */
const deadlineSignals = new WeakMap<Response, AbortSignal>();

/**
 * Whether `error`, raised while reading `response`, is the request's own
 * deadline cutting it: the deadline-capped signal aborted and the error is
 * its very abort reason (fetch rejects, and errors a body, with it).
 */
export function isDeadlineCut(response: Response, error: unknown) {
  const signal = deadlineSignals.get(response);
  return signal !== undefined && signal.aborted && error === signal.reason;
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
  /**
   * Stopped before the run settled, its signal aborted: by its own deadline
   * (`deadline`), or by the parent signal it was given (`parent`).
   */
  | { expired: true; cause: "deadline" | "parent" };

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
 * - `parent` aborted first: `{ expired: true, cause: "parent" }`, the run's
 *   signal aborted too; a later local deadline or failure changes nothing;
 * - already expired (or parent already aborted): the run is never started.
 *
 * The first of the three settles the outcome; the timer and the parent
 * listener are removed as soon as it is settled.
 */
export function withinDeadline<T>(
  deadline: number,
  run: (signal: AbortSignal) => PromiseLike<T>,
  parent?: AbortSignal,
): Promise<DeadlineOutcome<T>> {
  if (parent?.aborted) {
    return Promise.resolve({ expired: true, cause: "parent" });
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.resolve({ expired: true, cause: "deadline" });
  }

  const controller = new AbortController();
  let operation: Promise<T>;
  try {
    operation = Promise.resolve(run(controller.signal));
  } catch (error) {
    operation = Promise.reject(error);
  }
  operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;
  return Promise.race([
    operation.then((value) => ({ expired: false as const, value })),
    new Promise<{ expired: true; cause: "deadline" | "parent" }>((resolve) => {
      // Settled first, then the run is told: whatever it does next
      // (an abort error, a late answer) loses the race.
      timer = setTimeout(() => {
        resolve({ expired: true, cause: "deadline" });
        controller.abort();
      }, remaining);
      if (parent) {
        onParentAbort = () => {
          resolve({ expired: true, cause: "parent" });
          controller.abort(parent.reason);
        };
        parent.addEventListener("abort", onParentAbort, { once: true });
      }
    }),
  ]).finally(() => {
    clearTimeout(timer);
    if (onParentAbort) parent?.removeEventListener("abort", onParentAbort);
  });
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

    // The attempt's timeout, cut to the time left: when the deadline is
    // what cut it, this signal and its abort reason are the deadline's.
    // AbortSignal.timeout takes whole milliseconds (a deadline may not be).
    const deadlineCapped = budget < policy.timeoutMs;
    const signal = AbortSignal.timeout(
      Math.max(1, Math.floor(Math.min(policy.timeoutMs, budget))),
    );
    let response: Response | null = null;
    try {
      response = await fetchImpl(url, { ...init, signal });
    } catch (error) {
      // Our deadline cut it (fetch rejects with the signal's reason): no
      // time is left for another attempt. Anything else (network failure,
      // an abort that is not ours) is retried as before.
      if (deadlineCapped && signal.aborted && error === signal.reason) {
        throw deadlineExceeded();
      }
      response = null; // network error or attempt timeout
    }
    if (response && deadlineCapped) deadlineSignals.set(response, signal);

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

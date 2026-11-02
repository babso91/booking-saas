import type { ActionResult } from "@/lib/errors";

import {
  sameContext,
  type AppearancePreferences,
  type PreferenceContext,
  type PreferencesSnapshot,
} from "../model";
import {
  changeLocally,
  displayedAppearance,
  enterContext,
  initialSyncState,
  nextSave,
  readAnswered,
  readFailed,
  readNeeded,
  saveAnswered,
  saveFailed,
  startRead,
  unacknowledgedChanges,
  type SaveAnswer,
  type SaveRequest,
  type SyncState,
} from "./preference-sync";

// What drives preference-sync.ts on a page: the requests, their timeouts, the
// waits between attempts. The state machine decides; this only sends what it
// asks for and settles what it sent. Without React, so that races are played
// here with held answers and a fake clock (preference-driver.test.ts).
//
// Each request settles once: by its answer, its refusal, or its timeout. An
// answer after that is dropped. A timeout is not a precaution: Next.js never
// settles a Server Action whose navigation overtook it, and the save it
// carried may have been applied (sent again, it comes back `unchanged` or
// `stale`, both handled).
//
// A render of the layout says which context the page is in, nothing more:
// its preferences may be older than an answer already taken, so inside the
// same context they are ignored.
//
// A style that comes from elsewhere is not shown by itself. Each style has its
// own frame: drawing it mounts the page again and destroys what she was typing.
// It waits (`receivedStyle`) until she asks for it or goes to another page. Her
// own choice and another context are drawn at once; the other settings are only
// colours, and follow live.

export const REQUEST_TIMEOUT_MS = 15_000;
export const FIRST_RETRY_MS = 1_000;
export const LAST_RETRY_MS = 30_000;
/** focus and visibilitychange come together when she returns to the tab. */
const RETURN_GAP_MS = 1_000;

/** What a page says of its context: the session says who she is. */
type PageContext = Pick<PreferenceContext, "businessId" | "membershipId">;

const pageContext = ({
  businessId,
  membershipId,
}: PreferenceContext): PageContext => ({ businessId, membershipId });

export type DriverActions = {
  read: () => Promise<ActionResult<PreferencesSnapshot>>;
  save: (input: {
    context: PageContext;
    expected: SaveRequest["expected"];
    changes: SaveRequest["changes"];
  }) => Promise<ActionResult<SaveAnswer>>;
  importDevice: (input: {
    context: PageContext;
    appearance: AppearancePreferences;
  }) => Promise<ActionResult<SaveAnswer>>;
};

export type DriverHost = {
  /** The session may not be this page's any more: render the layout again. */
  refresh: () => void;
  isHidden: () => boolean;
};

export type DriverArea = {
  snapshot: PreferencesSnapshot | null;
  appearance: AppearancePreferences;
};

/**
 * idle: nothing waiting; saving: on its way; retrying: not answered, sent
 * again by itself; paused: refused for this session or too many conflicts;
 * unavailable: her account could not be read, nothing can be saved yet.
 */
export type SyncStatus =
  "idle" | "saving" | "retrying" | "paused" | "unavailable";

export type DriverView = {
  /** What to draw: her account's, in the style this page is showing. */
  appearance: AppearancePreferences;
  /** The style her account holds, when this page is not showing it yet. */
  receivedStyle: AppearancePreferences["style"] | null;
  status: SyncStatus;
  /** Whether her account holds a row (an old device's look is not offered). */
  accountHasPreferences: boolean;
  importing: "idle" | "sending" | "failed";
  /** A choice made on this page reached her account. */
  savedHere: boolean;
};

/** Pause saving: the session may not be this page's. */
const SESSION_REFUSALS = new Set([
  "context_changed",
  "unauthenticated",
  "forbidden",
  "no_business",
]);
/**
 * Those the server could only say by reading the session: the layout can tell.
 * Not `unauthenticated`: an authentication service that does not answer is
 * reported the same way, and the layout's guard would send her to sign in.
 */
const askLayout = (code: string) =>
  SESSION_REFUSALS.has(code) && code !== "unauthenticated";

export class PreferenceDriver {
  private state: SyncState | null;
  private fallback: AppearancePreferences;
  private shownStyle: AppearancePreferences["style"];
  /**
   * She kept the old device's look: a read is owed until one succeeds (each
   * failure waits its turn), and that read draws it at once.
   */
  private drawNextRead = false;
  private view: DriverView;
  private readonly listeners = new Set<() => void>();
  private running = false;
  /** Moved when the context changes: what was sent before is dropped. */
  private epoch = 0;
  private failures = 0;
  private waiting: ReturnType<typeof setTimeout> | null = null;
  private readDue = false;
  private readBeforeFirst = false;
  private lastReturn = -Infinity;
  private refreshAsked = false;
  private importing: DriverView["importing"] = "idle";
  private savedHere = false;

  constructor(
    area: DriverArea,
    private readonly actions: DriverActions,
    private readonly host: DriverHost,
  ) {
    this.state = area.snapshot ? initialSyncState(area.snapshot) : null;
    this.fallback = area.appearance;
    this.shownStyle = area.appearance.style;
    this.view = this.computeView();
  }

  getView = () => this.view;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start() {
    this.running = true;
    this.pump();
  }

  stop() {
    this.running = false;
    this.clearWait();
  }

  /** A render of the layout. Enters a context only if it is another one. */
  receiveArea(area: DriverArea) {
    if (!area.snapshot) {
      if (!this.state) {
        this.fallback = area.appearance;
        this.shownStyle = area.appearance.style;
        this.publish();
      }
      return;
    }
    if (!this.state) {
      this.leaveRequests();
      this.state = initialSyncState(area.snapshot);
    } else if (!sameContext(this.state.context, area.snapshot.context)) {
      this.leaveRequests();
      this.state = enterContext(this.state, area.snapshot);
      this.shownStyle = area.snapshot.preferences.appearance.style;
    } else {
      return;
    }
    this.publish();
    this.pump();
  }

  /** Her choice: shown at once, sent as soon as possible. */
  change(patch: Partial<AppearancePreferences>) {
    if (!this.state) return;
    this.state = changeLocally(this.state, {
      ...displayedAppearance(this.state),
      ...patch,
    });
    if (patch.style) this.shownStyle = patch.style;
    this.publish();
    this.pump();
  }

  /** She asked for it, or this page is gone: nothing left to protect. */
  applyReceivedStyle() {
    this.shownStyle = this.accountAppearance().style;
    this.publish();
  }

  /** She came back to the tab: one read, however many events say so. */
  returned() {
    const now = Date.now();
    if (now - this.lastReturn < RETURN_GAP_MS) return;
    this.lastReturn = now;
    if (this.state?.readsInFlight.length) return;
    this.readDue = true;
    this.pump();
  }

  /** She asked to try now: the wait is over. */
  retry() {
    this.clearWait();
    this.readDue = true;
    this.pump();
  }

  /**
   * Keeps the old device's look on her account, once she has said so. The
   * action writes only while the account has nothing, whatever this page
   * saw; what the account then holds comes from a read sent after it.
   * Resolves to whether the question is settled.
   */
  importDevice(appearance: AppearancePreferences): Promise<boolean> {
    const state = this.state;
    if (!state || this.importing === "sending") return Promise.resolve(false);
    this.importing = "sending";
    this.publish();
    return new Promise((resolve) => {
      this.settleOnce(
        this.actions.importDevice({
          context: pageContext(state.context),
          appearance,
        }),
        (result) => {
          if (result.ok) {
            this.importing = "idle";
            this.readDue = true;
            this.drawNextRead = true;
            resolve(true);
          } else {
            this.importing = "failed";
            if (askLayout(result.error.code)) this.askRefresh();
            resolve(false);
          }
        },
        () => {
          this.importing = "failed";
          resolve(false);
        },
        () => resolve(false),
      );
    });
  }

  /** Sends what is due, unless waiting after a failure. */
  private pump() {
    if (!this.running || this.waiting !== null) return;
    if (!this.state) {
      if (!this.host.isHidden()) this.readFirst();
      return;
    }
    const [state, request] = nextSave(this.state);
    this.state = state;
    if (request) this.sendSave(request);
    const stuck = this.state.paused && this.state.readsInFlight.length === 0;
    if (
      !this.host.isHidden() &&
      (this.readDue || this.drawNextRead || stuck || readNeeded(this.state))
    ) {
      this.sendRead();
    }
    this.publish();
  }

  private sendSave(request: SaveRequest) {
    const { ticket, context, expected, changes } = request;
    this.settleOnce(
      this.actions.save({ context: pageContext(context), expected, changes }),
      (result) => {
        if (result.ok) {
          const before = this.state!.paused;
          this.state = saveAnswered(this.state!, ticket, result.data);
          if (result.data.status !== "stale") {
            this.savedHere = true;
            this.succeeded();
          }
          if (!before && this.state.paused) this.failed();
          if (this.state.paused === "context_changed") this.askRefresh();
        } else if (SESSION_REFUSALS.has(result.error.code)) {
          this.state = saveFailed(this.state!, ticket, "context_changed");
          if (askLayout(result.error.code)) this.askRefresh();
          this.failed();
        } else {
          this.state = saveFailed(this.state!, ticket, "network");
          this.failed();
        }
      },
      () => {
        this.state = saveFailed(this.state!, ticket, "network");
        this.failed();
      },
    );
  }

  private sendRead() {
    this.readDue = false;
    const draw = this.drawNextRead;
    this.drawNextRead = false;
    const [state, ticket] = startRead(this.state!);
    this.state = state;
    this.settleOnce(
      this.actions.read(),
      (result) => {
        if (result.ok) {
          this.state = readAnswered(this.state!, ticket, result.data);
          if (this.state.paused) {
            // Answered for another context: only the layout can tell.
            this.askRefresh();
            this.failed();
          } else {
            this.refreshAsked = false;
            if (Object.keys(this.state.intents).length === 0) this.succeeded();
            if (draw) this.applyReceivedStyle();
          }
        } else {
          // Not a reason to render the layout: with the database away, a
          // read is refused too, and its guard would send her to sign in.
          this.state = readFailed(this.state!, ticket);
          this.drawNextRead ||= draw;
          this.failed();
        }
      },
      () => {
        this.state = readFailed(this.state!, ticket);
        this.drawNextRead ||= draw;
        this.failed();
      },
    );
  }

  /** The render had no account: a read gives this page its context. */
  private readFirst() {
    if (this.readBeforeFirst) return;
    this.readBeforeFirst = true;
    this.settleOnce(
      this.actions.read(),
      (result) => {
        this.readBeforeFirst = false;
        if (result.ok) {
          this.state = initialSyncState(result.data);
          this.succeeded();
        } else {
          this.failed();
        }
      },
      () => {
        this.readBeforeFirst = false;
        this.failed();
      },
    );
  }

  /**
   * Settles a request exactly once, within the epoch it was sent in; a later
   * context never hears of it (`dropped`, for who is waiting on it).
   */
  private settleOnce<T>(
    request: Promise<ActionResult<T>>,
    answered: (result: ActionResult<T>) => void,
    lost: () => void,
    dropped?: () => void,
  ) {
    const epoch = this.epoch;
    let settled = false;
    const settle = (apply: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (epoch !== this.epoch) {
        dropped?.();
        return;
      }
      apply();
      this.publish();
      this.pump();
    };
    const timeout = setTimeout(() => settle(lost), REQUEST_TIMEOUT_MS);
    request.then(
      (result) => settle(() => answered(result)),
      () => settle(lost),
    );
  }

  /** Leaving a context: nothing sent for it can act any more. */
  private leaveRequests() {
    this.epoch += 1;
    this.clearWait();
    this.failures = 0;
    this.readDue = false;
    this.readBeforeFirst = false;
    this.refreshAsked = false;
    this.importing = "idle";
    this.savedHere = false;
    this.drawNextRead = false;
  }

  private succeeded() {
    this.failures = 0;
    this.clearWait();
  }

  /** The next attempt waits: 1 s, 2 s, 4 s… up to 30 s. */
  private failed() {
    this.failures += 1;
    this.clearWait();
    if (!this.running) return;
    this.waiting = setTimeout(
      () => {
        this.waiting = null;
        this.pump();
        this.publish();
      },
      Math.min(FIRST_RETRY_MS * 2 ** (this.failures - 1), LAST_RETRY_MS),
    );
  }

  private clearWait() {
    if (this.waiting !== null) clearTimeout(this.waiting);
    this.waiting = null;
  }

  private askRefresh() {
    if (this.refreshAsked) return;
    this.refreshAsked = true;
    this.host.refresh();
  }

  private accountAppearance() {
    return this.state ? displayedAppearance(this.state) : this.fallback;
  }

  private computeView(): DriverView {
    const state = this.state;
    const account = this.accountAppearance();
    const drawn = {
      appearance: { ...account, style: this.shownStyle },
      receivedStyle: account.style === this.shownStyle ? null : account.style,
    };
    if (!state) {
      return {
        ...drawn,
        status: "unavailable",
        accountHasPreferences: false,
        importing: this.importing,
        savedHere: false,
      };
    }
    const waiting = Object.keys(unacknowledgedChanges(state)).length > 0;
    return {
      ...drawn,
      status: !waiting
        ? "idle"
        : state.paused
          ? "paused"
          : this.failures > 0
            ? "retrying"
            : "saving",
      accountHasPreferences: state.observed.version > 0,
      importing: this.importing,
      savedHere: this.savedHere,
    };
  }

  /** A new view only when something she can see changed. */
  private publish() {
    const next = this.computeView();
    if (JSON.stringify(next) === JSON.stringify(this.view)) return;
    this.view = next;
    this.listeners.forEach((listener) => listener());
  }
}

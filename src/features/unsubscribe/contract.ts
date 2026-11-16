// Stopping marketing messages from a link (R4-01, unsubscribe), as served
// (docs/MARKETING_CONSENT_CONTRACT.md). The page takes its actions as a
// whole: /desinscription gives it the real ones (real-actions.ts), the
// design preview and the tests an in-memory server.
//
// No login: the link's token alone proves which business and channel it
// is for, and nothing else. Opening the page changes nothing (link
// previews and mail scanners open links); only her click does. It never
// touches appointment reminders, which are not marketing.

export type UnsubscribeChannel = "email" | "sms";

export type UnsubscribeView = {
  businessName: string;
  channel: UnsubscribeChannel;
  /** Already withdrawn for this business and channel. */
  alreadyWithdrawn: boolean;
  /** Her withdrawal by this link can still be undone (30 minutes). */
  canUndo: boolean;
};

export type UnsubscribeResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type UnsubscribeActions = {
  /** Reads what the token is for; changes nothing. */
  read: (token: string) => Promise<UnsubscribeResult<UnsubscribeView>>;
  /** Idempotent: withdrawing twice answers the same. */
  withdraw: (token: string) => Promise<UnsubscribeResult<UnsubscribeView>>;
  /** Undo right after, if she clicked by mistake. */
  resubscribe: (token: string) => Promise<UnsubscribeResult<UnsubscribeView>>;
};

export const unsubscribeErrors = {
  /** Unknown, forged or expired token: one opaque answer. */
  invalid: "unsubscribe_link_invalid",
  /** No withdrawal by this link, or more than 30 minutes ago. */
  undoUnavailable: "unsubscribe_undo_unavailable",
} as const;

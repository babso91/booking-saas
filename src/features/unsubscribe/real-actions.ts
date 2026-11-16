import { callAction } from "@/features/auth/client/call-action";
import {
  readUnsubscribeAction,
  resubscribeUnsubscribeAction,
  withdrawUnsubscribeAction,
} from "@/features/marketing-consent/actions";

import type {
  UnsubscribeActions,
  UnsubscribeResult,
  UnsubscribeView,
} from "./contract";

// The page's actions on Cloud's Server Actions
// (docs/MARKETING_CONSENT_CONTRACT.md); an error keeps its code only.

async function run(
  action: () => Promise<
    { ok: true; data: UnsubscribeView } | { ok: false; error: { code: string } }
  >,
): Promise<UnsubscribeResult<UnsubscribeView>> {
  const result = await callAction(action as never);
  const answer = result as
    | { ok: true; data: UnsubscribeView }
    | { ok: false; error: { code: string } };
  return answer.ok ? answer : { ok: false, error: { code: answer.error.code } };
}

export const realUnsubscribeActions: UnsubscribeActions = {
  read: (token) => run(() => readUnsubscribeAction(token)),
  withdraw: (token) => run(() => withdrawUnsubscribeAction(token)),
  resubscribe: (token) => run(() => resubscribeUnsubscribeAction(token)),
};

/** The token in the fragment of her link (`#t=uns_…`), or null. */
export function unsubscribeTokenFrom(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("t");
  return value && /^uns_[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

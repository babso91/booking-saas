#!/usr/bin/env python3
"""Staging email hook: accept the app's `?next=` callback (invitation resume).

The app sends `<origin>/auth/callback?next=/invitation` as the recovery
redirect for an unconfirmed pre-existing account resuming an invitation
(src/features/auth/actions/auth.ts). The hook only accepted the bare
callback and always rebuilt it without `next`. This patch:
  - accepts `next` among the app's allowed paths only
    (src/features/auth/data/redirects.ts: /app, /onboarding, /login, /invitation);
  - keeps that exact redirect in the link;
  - changes nothing else (HMAC check, @example.test recipients, Mailpit only).

Run on the server, writes email-hook.mjs.next next to the live file:
  python3 patch-email-hook.py /opt/booking-saas-staging/email-hook.mjs
"""
import sys

path = sys.argv[1]
src = open(path).read()

old_allowed = '!["", `${ORIGIN}/auth/callback`].includes(data.redirect_to)'
new_allowed = '!allowedRedirect(data.redirect_to)'
old_message_sig = 'function message(email, hash, type) {'
new_message_sig = 'function message(email, hash, type, redirect = `${ORIGIN}/auth/callback`) {'
old_link = 'link.searchParams.set("redirect_to", `${ORIGIN}/auth/callback`);'
new_link = 'link.searchParams.set("redirect_to", redirect);'
old_return = 'return [message(user.email, data.token_hash, data.email_action_type)];'
new_return = ('return [message(user.email, data.token_hash, data.email_action_type,\n'
              '    data.redirect_to || `${ORIGIN}/auth/callback`)];')
helper = '''
// The app's callback, bare or with one allowed `next` (redirects.ts).
const NEXT_PATHS = ["/app", "/onboarding", "/login", "/invitation"];
export function allowedRedirect(value) {
  if (value === "" || value === `${ORIGIN}/auth/callback`) return true;
  return NEXT_PATHS.some(
    (next) => value === `${ORIGIN}/auth/callback?next=${encodeURIComponent(next)}`,
  );
}

'''

for old in (old_allowed, old_message_sig, old_link, old_return):
    if src.count(old) != 1:
        sys.exit(f"STOP: pattern not found exactly once: {old[:60]}")
out = (src.replace(old_allowed, new_allowed)
          .replace(old_message_sig, new_message_sig)
          .replace(old_link, new_link)
          .replace(old_return, new_return))
anchor = "export function messagesFor(payload) {"
if out.count(anchor) != 1:
    sys.exit("STOP: messagesFor not found")
out = out.replace(anchor, helper + anchor)
open(path + ".next", "w").write(out)
print(f"written {path}.next")

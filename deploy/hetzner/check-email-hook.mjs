// Checks a patched email-hook.mjs.next without running its server:
//   node check-email-hook.mjs /opt/booking-saas-staging/email-hook.mjs.next
// Exit 0 when every case behaves as expected.
import { copyFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const tmp = `/tmp/email-hook-check-${process.pid}.mjs`;
copyFileSync(process.argv[2], tmp);
const hook = await import(pathToFileURL(tmp).href);
const O = hook.ORIGIN;
const hash = "pkce_" + "a".repeat(56);
const payload = (
  redirect_to,
  email = "lea@example.test",
  type = "recovery",
) => ({
  user: { email },
  email_data: {
    site_url: O,
    redirect_to,
    token_hash: hash,
    email_action_type: type,
  },
});
const link = (p) => hook.messagesFor(p)[0].Text.match(/https:\S+/)[0];
const redirectOf = (p) => new URL(link(p)).searchParams.get("redirect_to");
const refused = (p) => {
  try {
    hook.messagesFor(p);
    return false;
  } catch {
    return true;
  }
};

const cases = [
  [
    "bare callback kept",
    redirectOf(payload(`${O}/auth/callback`)) === `${O}/auth/callback`,
  ],
  [
    "empty redirect -> bare callback",
    redirectOf(payload("")) === `${O}/auth/callback`,
  ],
  [
    "invitation resume accepted and kept",
    redirectOf(payload(`${O}/auth/callback?next=%2Finvitation`)) ===
      `${O}/auth/callback?next=%2Finvitation`,
  ],
  [
    "signup with next=/app accepted",
    redirectOf(
      payload(`${O}/auth/callback?next=%2Fapp`, "a@example.test", "signup"),
    ) === `${O}/auth/callback?next=%2Fapp`,
  ],
  ["unknown next refused", refused(payload(`${O}/auth/callback?next=%2Fevil`))],
  [
    "open redirect refused",
    refused(payload("https://evil.example/auth/callback")),
  ],
  [
    "extra parameter refused",
    refused(payload(`${O}/auth/callback?next=%2Fapp&x=1`)),
  ],
  [
    "real recipient still refused",
    refused(payload(`${O}/auth/callback`, "jade@gmail.com")),
  ],
];
let ok = true;
for (const [name, pass] of cases) {
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
  ok &&= pass;
}
process.exit(ok ? 0 : 1);

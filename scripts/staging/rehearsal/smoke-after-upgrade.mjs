// Local rehearsal only: checks, after the 24 -> 35 upgrade, that the accounts
// and data created by seed-staging-like.mjs still work. Exit code 1 on a FAIL.
import { readFileSync } from "node:fs";
const st = JSON.parse(readFileSync(process.argv[2], "utf8"));
const API = st.API_URL,
  SK = st.SERVICE_ROLE_KEY,
  AK = st.ANON_KEY;
const call = async (path, body, token = AK, method = "POST") => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      apikey: AK,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
const ok = (label, cond, extra = "") => {
  if (!cond) process.exitCode = 1;
  console.log(
    `${cond ? "ok  " : "FAIL"} ${label}${extra ? " — " + extra : ""}`,
  );
};
const login = await call("/auth/v1/token?grant_type=password", {
  email: "staging-like-1@example.test",
  password: "Staging-Like-1-2026!",
});
ok("existing account signs in after the upgrade", login.status === 200);
const token = login.body.access_token;
const beta = await call("/rest/v1/rpc/my_beta_access", {}, token);
ok(
  "existing account keeps beta access (source existing)",
  beta.status === 200 && JSON.stringify(beta.body).includes("true"),
  JSON.stringify(beta.body).slice(0, 80),
);
const mine = await call(
  "/rest/v1/businesses?select=id,slug",
  null,
  token,
  "GET",
);
ok(
  "she still sees her business (RLS)",
  mine.status === 200 &&
    mine.body.length === 1 &&
    mine.body[0].slug === "studio-1-legacy",
);
const businessId = mine.body[0].id;
const appts = await call(
  `/rest/v1/appointments?select=id,status&business_id=eq.${businessId}`,
  null,
  token,
  "GET",
);
ok(
  "her existing appointment is in her agenda",
  appts.status === 200 && appts.body.length === 1,
  JSON.stringify(appts.body),
);
const other = await call(
  "/rest/v1/businesses?select=id&slug=eq.studio-2-legacy",
  null,
  token,
  "GET",
);
ok(
  "she cannot see the other business",
  other.status === 200 && other.body.length === 0,
);
const pub = await call("/rest/v1/rpc/get_public_business", {
  p_slug: "studio-1-legacy",
});
ok("public business readable anonymously", pub.status === 200);
const services = await call("/rest/v1/rpc/get_public_services", {
  p_slug: "studio-1-legacy",
});
const serviceId = services.body?.[0]?.id ?? services.body?.[0]?.service_id;
const day = new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10);
const avail = await call("/rest/v1/rpc/get_public_availability", {
  p_slug: "studio-1-legacy",
  p_service_id: serviceId,
  p_date: day,
  p_option_choice_ids: [],
});
ok(
  "public availability for the legacy service",
  avail.status === 200 && avail.body.slots.length > 0,
  `${avail.body.slots.length} slots`,
);
const slot = { starts_at: avail.body.slots[3].startsAt };
const anonBook = await call("/rest/v1/rpc/create_public_booking", {
  p_slug: "studio-1-legacy",
  p_service_id: serviceId,
  p_starts_at: slot.starts_at,
  p_first_name: "Nina",
  p_email: "nina@example.test",
  p_request_id: crypto.randomUUID(),
  p_client_ip: "198.51.100.4",
});
ok(
  "booking refused to the anonymous key (service only)",
  anonBook.status >= 400,
  String(anonBook.status),
);
const book = await call(
  "/rest/v1/rpc/create_public_booking",
  {
    p_slug: "studio-1-legacy",
    p_service_id: serviceId,
    p_starts_at: slot.starts_at,
    p_first_name: "Nina",
    p_email: "nina@example.test",
    p_request_id: crypto.randomUUID(),
    p_client_ip: "198.51.100.4",
  },
  SK,
);
ok(
  "new public booking on the legacy business (as the route does)",
  book.status === 200,
  JSON.stringify(book.body).slice(0, 90),
);
const cat = await call(
  "/rest/v1/rpc/create_service_category",
  {
    p_business_id: businessId,
    p_request_id: crypto.randomUUID(),
    p_name: "Cils",
    p_visible: true,
  },
  token,
);
ok(
  "new catalogue feature works for the legacy account (category)",
  cat.status === 200,
  String(cat.status),
);
const invite = await call(
  "/rest/v1/rpc/create_beta_invitation",
  {
    p_email: "x@example.test",
    p_token_hash: "x",
    p_expires_at: "2030-01-01T00:00:00Z",
    p_note: null,
  },
  token,
);
ok(
  "invitations stay service-only",
  invite.status >= 400,
  String(invite.status),
);
if (process.exitCode) process.exit(1);

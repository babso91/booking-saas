// Local rehearsal only (scripts/staging/rehearsal/rehearse.sh): data shaped
// like staging on 8 Nov 2026 (2 confirmed accounts, 2 businesses, 2 services,
// 1 future public booking), created through the entry points of migration
// level 20261016090000. Fake addresses, local stack only.
import { readFileSync } from "node:fs";
const st = JSON.parse(readFileSync(process.argv[2], "utf8"));
const API = st.API_URL,
  SK = st.SERVICE_ROLE_KEY,
  AK = st.ANON_KEY;
const j = async (r) => {
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
};
const rpc = (name, body, token = AK) =>
  fetch(`${API}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: AK,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).then(j);
const day = new Date(Date.now() + 9 * 86400e3).toISOString().slice(0, 10);
for (const [n, who] of [
  [1, "Camille"],
  [2, "Inès"],
]) {
  const email = `staging-like-${n}@example.test`,
    password = `Staging-Like-${n}-2026!`;
  await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SK,
      Authorization: `Bearer ${SK}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  }).then(j);
  const session = await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: AK, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).then(j);
  const token = session.access_token;
  const business = await rpc(
    "complete_onboarding",
    {
      p_first_name: who,
      p_last_name: "Test",
      p_business_name: `Studio ${who}`,
      p_slug: `studio-${n}-legacy`,
      p_timezone: "Europe/Paris",
      p_description: "",
      p_contact_email: email,
      p_phone: "",
      p_location: "Paris",
      p_cancellation_policy: "",
      p_minimum_booking_notice_minutes: 60,
      p_maximum_booking_advance_days: 60,
      p_buffer_minutes: 0,
    },
    token,
  );
  const b0 = Array.isArray(business)
    ? business[0]
    : typeof business === "string" && business.startsWith("{")
      ? JSON.parse(business)
      : business;
  const businessId = typeof b0 === "string" ? b0 : (b0.business_id ?? b0.id);
  const service = await rpc(
    "create_service",
    {
      p_business_id: businessId,
      p_request_id: crypto.randomUUID(),
      p_name: n === 1 ? "Pose cil à cil" : "Manucure",
      p_duration_minutes: 60,
      p_price_cents: 6500,
      p_description: "",
      p_active: true,
      p_display_order: 0,
    },
    token,
  );
  const s0 = Array.isArray(service)
    ? service[0]
    : typeof service === "string" && service.startsWith("{")
      ? JSON.parse(service)
      : service;
  const serviceId =
    typeof s0 === "string"
      ? s0
      : (s0.id ?? s0.service_id ?? Object.values(s0)[0]);
  const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
    weekday: d,
    starts_at: "09:00",
    ends_at: "18:00",
  }));
  await rpc(
    "replace_business_hours",
    { p_business_id: businessId, p_hours: hours, p_expected: [] },
    token,
  ).catch((e) => console.log("hours:", e.message.slice(0, 200)));
  if (n === 1) {
    const slots = await rpc("get_available_slots", {
      p_slug: `studio-1-legacy`,
      p_service_id: serviceId,
      p_date: day,
    });
    console.log("slots", slots.length, JSON.stringify(slots[0]));
    const booking = await rpc(
      "create_public_booking",
      {
        p_slug: "studio-1-legacy",
        p_service_id: serviceId,
        p_starts_at: slots[2].startsAt ?? slots[2].starts_at,
        p_first_name: "Léa",
        p_email: "lea.client@example.test",
        p_last_name: "Martin",
        p_phone: "",
      },
      SK,
    ).catch(async (e) => {
      console.log("public booking as service:", e.message.slice(0, 200));
      return null;
    });
    console.log("booking", JSON.stringify(booking).slice(0, 160));
  }
  console.log("seeded", n, businessId, serviceId);
}

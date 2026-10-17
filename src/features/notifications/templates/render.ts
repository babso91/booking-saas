import { formatPrice } from "@/features/agenda/client/money";
import { weekdayOfLocalDate } from "@/lib/time/local-date";

import type { ClaimedEmail, EmailType } from "../schemas/claimed-email";

// Customer emails, in French, addressed with "vous" like the booking page.
// Every value comes from the claimed email (the business's own data and
// this appointment's snapshots): no CRM field (notes, other appointments,
// loyalty) is ever read. Plain text is the reference; the HTML version
// escapes every interpolated value. No link lets the customer cancel or
// change the appointment (none exists yet): the email says to contact the
// business, and replies go to its contact address.

export type RenderedEmail = { subject: string; text: string; html: string };

const WEEKDAYS = [
  "dimanche",
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
];
const MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

/** "samedi 24 octobre 2026", from a business wall clock "YYYY-MM-DDTHH:MM". */
export function formatLocalDate(wallClock: string) {
  const date = wallClock.slice(0, 10);
  const [year, month, day] = date.split("-").map(Number);
  return `${WEEKDAYS[weekdayOfLocalDate(date)]} ${day} ${MONTHS[month! - 1]} ${year}`;
}

/** "9 h 30", "14 h". */
export function formatLocalTime(wallClock: string) {
  const [hours, minutes] = wallClock.slice(11, 16).split(":");
  const h = String(Number(hours));
  return minutes === "00" ? `${h} h` : `${h} h ${minutes}`;
}

/** "45 min", "1 h", "1 h 30". */
export function formatDuration(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}

/** One line of text: control characters (CR, LF…) become spaces. */
export function singleLine(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const HEADLINES: Record<EmailType, { subject: string; lead: string }> = {
  booking_confirmation: {
    subject: "Rendez-vous confirmé",
    lead: "Votre rendez-vous est confirmé.",
  },
  appointment_reminder: {
    subject: "Rappel de votre rendez-vous",
    lead: "Petit rappel de votre prochain rendez-vous.",
  },
  appointment_changed: {
    subject: "Rendez-vous modifié",
    lead: "Votre rendez-vous a été modifié. Voici ses nouvelles informations.",
  },
  appointment_cancelled: {
    subject: "Rendez-vous annulé",
    lead: "Votre rendez-vous a été annulé par l’établissement.",
  },
};

export function renderEmail(
  email: ClaimedEmail,
  options: { appUrl: string },
): RenderedEmail {
  const business = singleLine(email.business.name);
  const service = singleLine(email.appointment.serviceName);
  const firstName = email.appointment.clientFirstName
    ? singleLine(email.appointment.clientFirstName)
    : null;
  const headline = HEADLINES[email.type];
  const when = `${formatLocalDate(email.appointment.localStartsAt)} à ${formatLocalTime(email.appointment.localStartsAt)}`;
  const publicUrl = new URL(
    `/b/${encodeURIComponent(email.business.slug)}`,
    options.appUrl,
  ).toString();
  const cancelled = email.type === "appointment_cancelled";

  const details: [string, string][] = [
    ["Établissement", business],
    ["Prestation", service],
    ["Date", when],
    ["Durée", formatDuration(email.appointment.durationMinutes)],
  ];
  if (!cancelled) {
    details.push([
      "Prix",
      formatPrice(email.appointment.priceCents, email.appointment.currency),
    ]);
  }
  if (email.business.location && !cancelled) {
    details.push(["Adresse", singleLine(email.business.location)]);
  }

  const contact = [
    email.business.phone
      ? `par téléphone au ${singleLine(email.business.phone)}`
      : null,
    "en répondant à cet email",
  ]
    .filter(Boolean)
    .join(" ou ");
  const closing = cancelled
    ? `Pour reprendre rendez-vous : ${publicUrl}`
    : `Pour modifier ou annuler, contactez ${business} ${contact}.`;
  const timezoneNote = `Heures indiquées à l’heure de l’établissement (${email.business.timezone}).`;

  const subject = singleLine(`${headline.subject} – ${business}`);
  const greeting = firstName ? `Bonjour ${firstName},` : "Bonjour,";

  const text = [
    greeting,
    "",
    headline.lead,
    "",
    ...details.map(([label, value]) => `${label} : ${value}`),
    "",
    timezoneNote,
    "",
    closing,
    ...(cancelled ? [] : ["", `Page de l’établissement : ${publicUrl}`]),
    "",
    `— ${business}`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="fr">
<body style="font-family:Arial,Helvetica,sans-serif;color:#1f1f1f;line-height:1.5">
<p>${escapeHtml(greeting)}</p>
<p>${escapeHtml(headline.lead)}</p>
<table role="presentation" cellpadding="4" cellspacing="0">
${details
  .map(
    ([label, value]) =>
      `<tr><td style="color:#666">${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`,
  )
  .join("\n")}
</table>
<p style="color:#666;font-size:13px">${escapeHtml(timezoneNote)}</p>
<p>${escapeHtml(cancelled ? "Pour reprendre rendez-vous :" : closing)}${
    cancelled
      ? ` <a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a>`
      : ""
  }</p>
${
  cancelled
    ? ""
    : `<p><a href="${escapeHtml(publicUrl)}">Page de l’établissement</a></p>`
}
<p>— ${escapeHtml(business)}</p>
</body>
</html>`;

  return { subject, text, html };
}

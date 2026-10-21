import "server-only";

import type { ConfiguredTransport } from "@/features/notifications/transport";

// The login code email. Sent directly through the configured transport
// (the same abstraction as the outbox worker), not through the outbox: the
// outbox is per business and appointment, and freezes every rendered
// message in the database (private.email_renderings), where a live
// credential must not be kept. A failed send is not retried: the customer
// asks for a new code (rate-limited). The idempotency key is the challenge:
// a provider never delivers one code twice.

const SEND_TIMEOUT_MS = 10_000;

export async function sendLoginCode(
  configured: ConfiguredTransport,
  input: { to: string; code: string; challengeId: string },
) {
  const text = [
    "Bonjour,",
    "",
    `Votre code de connexion à votre espace client : ${input.code}`,
    "",
    "Il est valable 10 minutes et ne sert qu’une fois.",
    "Si vous n’avez rien demandé, ignorez cet email : personne ne peut accéder à votre espace sans ce code.",
  ].join("\n");
  const html = `<p>Bonjour,</p><p>Votre code de connexion à votre espace client&nbsp;: <strong style="font-size:20px;letter-spacing:4px">${input.code}</strong></p><p>Il est valable 10 minutes et ne sert qu’une fois.</p><p>Si vous n’avez rien demandé, ignorez cet email&nbsp;: personne ne peut accéder à votre espace sans ce code.</p>`;

  await configured.transport.send(
    {
      to: input.to,
      from: configured.from,
      subject: `${input.code} est votre code de connexion`,
      text,
      html,
      idempotencyKey: `client-hub-code-${input.challengeId}`,
    },
    AbortSignal.timeout(SEND_TIMEOUT_MS),
  );
}

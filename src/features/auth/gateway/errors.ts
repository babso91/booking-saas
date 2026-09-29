import type { GatewayError, GatewayErrorCode } from "./contract";

// Human copy for every error the gateway can return. Short, calm, actionable.
// Raw provider messages are never displayed.
export const gatewayErrorCopy: Record<
  GatewayErrorCode,
  { title: string; message: string }
> = {
  invalid_credentials: {
    title: "Identifiants incorrects",
    message: "L’email ou le mot de passe ne correspond pas. Réessaie.",
  },
  email_not_confirmed: {
    title: "Email à confirmer",
    message:
      "Clique sur le lien reçu par email pour activer ton compte, puis reconnecte-toi.",
  },
  email_taken: {
    title: "Adresse déjà utilisée",
    message: "Un compte existe déjà avec cet email. Connecte-toi plutôt.",
  },
  weak_password: {
    title: "Mot de passe trop simple",
    message: "Choisis un mot de passe d’au moins 8 caractères.",
  },
  rate_limited: {
    title: "Un instant",
    message: "Trop de tentatives d’affilée. Patiente une minute et réessaie.",
  },
  slug_taken: {
    title: "Lien déjà pris",
    message:
      "Ce lien vient d’être choisi par quelqu’un d’autre. Choisis-en un autre.",
  },
  already_onboarded: {
    title: "Ton espace existe déjà",
    message: "Ton activité est déjà configurée. Tu peux y accéder directement.",
  },
  unauthorized: {
    title: "Session expirée",
    message: "Reconnecte-toi pour continuer. Tes réponses sont conservées.",
  },
  invalid_input: {
    title: "Quelques informations à revoir",
    message: "Vérifie les champs indiqués puis réessaie.",
  },
  network: {
    title: "Connexion interrompue",
    message: "Impossible de joindre le serveur. Vérifie ta connexion.",
  },
  unknown: {
    title: "Petit contretemps",
    message: "Quelque chose n’a pas fonctionné. Réessaie dans un instant.",
  },
};

export function describeGatewayError(error: GatewayError) {
  return gatewayErrorCopy[error.code] ?? gatewayErrorCopy.unknown;
}

// Supabase Auth error codes → gateway codes. Kept here so the real adapter
// can reuse it; see https://supabase.com/docs/guides/auth/debugging/error-codes
const supabaseAuthCodes: Record<string, GatewayErrorCode> = {
  invalid_credentials: "invalid_credentials",
  email_not_confirmed: "email_not_confirmed",
  user_already_exists: "email_taken",
  email_exists: "email_taken",
  weak_password: "weak_password",
  over_request_rate_limit: "rate_limited",
  over_email_send_rate_limit: "rate_limited",
  session_not_found: "unauthorized",
  session_expired: "unauthorized",
  no_authorization: "unauthorized",
  bad_jwt: "unauthorized",
  validation_failed: "invalid_input",
};

const gatewayCodes = new Set<string>([
  "invalid_credentials",
  "email_not_confirmed",
  "email_taken",
  "weak_password",
  "rate_limited",
  "slug_taken",
  "already_onboarded",
  "unauthorized",
  "invalid_input",
  "network",
  "unknown",
]);

function isGatewayErrorCode(value: unknown): value is GatewayErrorCode {
  return typeof value === "string" && gatewayCodes.has(value);
}

/**
 * Converts anything an adapter may catch (Supabase AuthError, PostgREST error
 * with a business code, fetch TypeError, AbortError…) into a `GatewayError`.
 * Unknown shapes become `unknown`: SQLSTATEs, stack traces or provider
 * messages are dropped on purpose.
 */
export function normalizeGatewayError(error: unknown): GatewayError {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { code: "network" };
  }

  if (error instanceof TypeError) {
    // fetch() rejects with a TypeError when the network is unreachable.
    return { code: "network" };
  }

  if (typeof error !== "object" || error === null) {
    return { code: "unknown" };
  }

  const candidate = error as {
    code?: unknown;
    name?: unknown;
    status?: unknown;
    message?: unknown;
  };

  if (candidate.name === "AuthRetryableFetchError") {
    return { code: "network" };
  }

  if (typeof candidate.code === "string") {
    const mapped = supabaseAuthCodes[candidate.code];

    if (mapped) {
      return { code: mapped };
    }

    if (isGatewayErrorCode(candidate.code)) {
      return { code: candidate.code };
    }
  }

  // Business RPC errors are expected to carry their stable code as message
  // (e.g. `raise exception 'slug_taken'`), never the SQL details.
  if (isGatewayErrorCode(candidate.message)) {
    return { code: candidate.message };
  }

  if (candidate.status === 401 || candidate.status === 403) {
    return { code: "unauthorized" };
  }

  if (candidate.status === 429) {
    return { code: "rate_limited" };
  }

  return { code: "unknown" };
}

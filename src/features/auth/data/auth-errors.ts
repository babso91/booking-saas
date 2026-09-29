import { AppException, type AppErrorCode } from "@/lib/errors";

type AuthErrorLike = {
  code?: string;
  status?: number;
  message?: string;
};

// Supabase Auth (GoTrue) error codes → stable application codes. The UI never
// has to interpret provider errors.
const authErrorCodes: Record<string, AppErrorCode> = {
  invalid_credentials: "invalid_credentials",
  email_not_confirmed: "email_not_confirmed",
  user_already_exists: "email_taken",
  email_exists: "email_taken",
  weak_password: "validation_error",
  email_address_invalid: "validation_error",
  validation_failed: "validation_error",
  over_request_rate_limit: "rate_limited",
  over_email_send_rate_limit: "rate_limited",
  signup_disabled: "forbidden",
  email_provider_disabled: "forbidden",
  session_not_found: "unauthenticated",
  refresh_token_not_found: "unauthenticated",
  user_not_found: "unauthenticated",
};

export function authErrorCode(error: AuthErrorLike): AppErrorCode {
  if (error.code && error.code in authErrorCodes) {
    return authErrorCodes[error.code]!;
  }

  if (error.status === 429) {
    return "rate_limited";
  }

  return "internal";
}

export function authException(error: AuthErrorLike) {
  const code = authErrorCode(error);
  const fieldErrors: Record<string, string[]> | undefined =
    error.code === "weak_password"
      ? { password: ["Ce mot de passe est trop faible."] }
      : error.code === "email_address_invalid"
        ? { email: ["Adresse email invalide."] }
        : undefined;

  return new AppException(code, { cause: error, fieldErrors });
}

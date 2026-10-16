import "server-only";

import { AppException, httpStatusByErrorCode, toAppError } from "@/lib/errors";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function jsonOk(data: unknown, init?: { status?: number }) {
  return Response.json(
    { data },
    { status: init?.status ?? 200, headers: NO_STORE },
  );
}

/** Serialises any error as `{ error: { code, message, fieldErrors? } }`. */
export function jsonError(error: unknown) {
  if (!(error instanceof AppException) || error.code === "internal") {
    console.error("Route handler failed", error);
  }

  const appError = toAppError(error);

  return Response.json(
    { error: appError },
    { status: httpStatusByErrorCode[appError.code], headers: NO_STORE },
  );
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppException("validation_error", {
      message: "Le corps de la requête doit être un JSON valide.",
    });
  }
}

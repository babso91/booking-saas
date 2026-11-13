import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { AppException } from "@/lib/errors";

// The caller's network address, as the trusted ingress (our reverse proxy)
// established it: never as the caller declares it.
//
// The reverse proxy in front of the application must, for every request:
//   - set `x-booking-client-ip` to the address of the TCP peer it accepted
//     the connection from (nginx `$remote_addr`, Caddy `{remote_host}`),
//     replacing any value the client sent;
//   - set `x-booking-proxy-secret` to BOOKING_PROXY_SECRET, replacing any
//     value the client sent.
// The secret proves the address was written by the proxy: a request that
// reaches the application any other way (direct access, a forged header)
// cannot carry it. In this mode, `x-forwarded-for`, `x-real-ip` and the
// like are never read: their content is chosen by whoever sent them.
//
// Without BOOKING_PROXY_SECRET, or without a proven address, no identity is
// established and the booking is refused (fail closed): there is no shared
// fallback identity, and the abuse limits are never skipped.
// Deployment: docs/PUBLIC_BOOKING_CONTRACT.md, "Ingress de confiance"
// (§ 9.1, and § 9.1 bis for Vercel).

//
// Second ingress, for a deployment on Vercel (BOOKING_TRUSTED_INGRESS=vercel):
// there, Vercel's own edge is the reverse proxy. It is the only way into a
// Vercel function, and it overwrites `x-forwarded-for`, `x-real-ip` and
// `x-vercel-forwarded-for` with the caller's address, never forwarding what
// the client sent ("Vercel overwrites this header and does not forward
// external IPs to prevent IP spoofing": vercel.com/docs/headers/request-headers).
// That guarantee holds only on Vercel, so the mode demands evidence of the
// platform, not only the variable:
//   - VERCEL=1, set by the platform itself in its functions;
//   - `x-vercel-id` on the request, stamped by Vercel's edge;
//   - `x-vercel-forwarded-for` and `x-real-ip` each one literal address,
//     and the same one (the edge writes both: a disagreement means something
//     else wrote one of them, and nothing is trusted).
// In this mode the proxy headers above are ignored; in the proxy mode (the
// default) the Vercel headers are ignored. An unknown mode refuses everything.
// Limit: a proxy of ours put in front of Vercel would make its own address
// everyone's (one shared quota, never a forged address).

export const CLIENT_IP_HEADER = "x-booking-client-ip";
export const PROXY_SECRET_HEADER = "x-booking-proxy-secret";
export const VERCEL_ID_HEADER = "x-vercel-id";
export const VERCEL_FORWARDED_FOR_HEADER = "x-vercel-forwarded-for";
export const VERCEL_REAL_IP_HEADER = "x-real-ip";

const digest = (value: string) => createHash("sha256").update(value).digest();

function proxySecret(): string | null {
  const secret = process.env.BOOKING_PROXY_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

type Ingress = "proxy" | "vercel";

/** The configured ingress; null for an unknown value (refuse everything). */
function ingress(): Ingress | null {
  const mode = process.env.BOOKING_TRUSTED_INGRESS ?? "";
  if (mode === "" || mode === "proxy") return "proxy";
  if (mode === "vercel") return "vercel";
  return null;
}

/**
 * The trusted client address of `request` (IPv4, or IPv6 in canonical
 * form; an IPv4-mapped IPv6 address is its IPv4). Throws
 * `booking_unavailable` when it cannot be established.
 */
export function trustedClientIp(request: Request): string {
  const mode = ingress();
  if (mode === null) {
    console.error(
      "Public booking refused: BOOKING_TRUSTED_INGRESS has an unknown value.",
    );
    throw new AppException("booking_unavailable");
  }
  return mode === "vercel" ? vercelClientIp(request) : proxyClientIp(request);
}

function vercelClientIp(request: Request): string {
  if (process.env.VERCEL !== "1") {
    console.error(
      "Public booking refused: BOOKING_TRUSTED_INGRESS=vercel outside Vercel.",
    );
    throw new AppException("booking_unavailable");
  }
  if (!request.headers.get(VERCEL_ID_HEADER)) {
    throw new AppException("booking_unavailable");
  }
  const forwarded = normalizeAddress(
    request.headers.get(VERCEL_FORWARDED_FOR_HEADER),
  );
  const real = normalizeAddress(request.headers.get(VERCEL_REAL_IP_HEADER));
  if (!forwarded || forwarded !== real) {
    throw new AppException("booking_unavailable");
  }
  return forwarded;
}

function proxyClientIp(request: Request): string {
  const secret = proxySecret();
  if (!secret) {
    console.error(
      "Public booking refused: BOOKING_PROXY_SECRET is not configured.",
    );
    throw new AppException("booking_unavailable");
  }

  const presented = request.headers.get(PROXY_SECRET_HEADER);
  if (!presented || !timingSafeEqual(digest(presented), digest(secret))) {
    throw new AppException("booking_unavailable");
  }

  const address = normalizeAddress(request.headers.get(CLIENT_IP_HEADER));
  if (!address) {
    throw new AppException("booking_unavailable");
  }
  return address;
}

/** One literal IP address, or null (lists, ports, zones, names: refused). */
export function normalizeAddress(value: string | null): string | null {
  // One bare address: no list, port, brackets, zone (%) or whitespace.
  if (!value || value.length > 45 || /[^0-9a-fA-F:.]/.test(value)) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  const family = isIP(value);
  if (family === 4) return value;
  if (family === 6) return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  return null;
}

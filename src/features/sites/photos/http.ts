import "server-only";

// The proxies' answers (docs/SITE_PUBLISHING_CONTRACT.md § 8). Public: the
// CDN may keep a photo five minutes at most and browsers revalidate every
// time (no stale-while-revalidate), so a revoked or unpublished photo stops
// being served within five minutes without any purge. Preview: never
// stored anywhere, not even by her browser. Anything else (refused,
// missing, failed) is never stored anywhere.

export const PUBLIC_PHOTO_CACHE = "public, max-age=0, s-maxage=300";
// The preview is never stored, not even by her own browser: on a shared
// computer, the next person signed in must not be shown it (Codex audit).
export const PRIVATE_PHOTO_CACHE = "no-store";
export const NO_STORE = "no-store";

/**
 * The CDN tag of a photo's public answers (Vercel-Cache-Tag): a targeted
 * purge on revocation stays possible (contract § 8). Not wired yet: no
 * purge is promised until it is tested on the real host.
 */
export const sitePhotoCacheTag = (assetId: string) => `site-photo-${assetId}`;

export function photoResponse(
  body: ArrayBuffer,
  cacheControl: string,
  cacheTag?: string,
) {
  return new Response(body, {
    status: 200,
    headers: {
      ...(cacheTag ? { "Vercel-Cache-Tag": cacheTag } : {}),
      "Content-Type": "image/webp",
      "Content-Length": String(body.byteLength),
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-site",
    },
  });
}

/** An image that cannot be served: never cached, the same for every cause. */
export function photoNotFound() {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": NO_STORE },
  });
}

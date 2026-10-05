/**
 * The only query parameter the OAuth callback adds when it sends the
 * professional back (`?calendar=<result>`, see the callback route).
 */
export const CALLBACK_PARAM = "calendar";

/**
 * The same address without the callback result, every other query parameter
 * and the fragment kept as they are; null when there is nothing to remove.
 */
export function withoutCallbackResult(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has(CALLBACK_PARAM)) return null;
  url.searchParams.delete(CALLBACK_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

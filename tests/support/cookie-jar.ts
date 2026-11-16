// A browser's cookie jar, for tests of real route handlers: it applies
// every Set-Cookie of a response the way a browser does (RFC 6265: a
// cookie is identified by name, domain and path; Max-Age=0 or a past
// Expires deletes it, whatever its value), and sends back the cookies
// whose path matches a request. Responses can be applied late, in any
// order: that is the point (a slow answer's headers still hit the jar).

type Stored = { name: string; value: string; path: string; httpOnly: boolean };

export class CookieJar {
  private cookies = new Map<string, Stored>();

  /** Applies a response's Set-Cookie headers, like a browser on arrival. */
  apply(response: Response) {
    for (const line of response.headers.getSetCookie()) this.set(line);
  }

  set(line: string) {
    const [pair, ...attributes] = line.split(";").map((part) => part.trim());
    const index = pair!.indexOf("=");
    const name = pair!.slice(0, index);
    const value = pair!.slice(index + 1);
    let path = "/";
    let httpOnly = false;
    let expired = false;
    for (const attribute of attributes) {
      const [key, raw = ""] = attribute.split("=");
      const lower = key!.toLowerCase();
      if (lower === "path") path = raw;
      if (lower === "httponly") httpOnly = true;
      if (lower === "max-age" && Number(raw) <= 0) expired = true;
      if (lower === "expires" && Date.parse(raw) <= Date.now()) expired = true;
    }
    const key = `${name}|${path}`;
    if (expired) this.cookies.delete(key);
    else this.cookies.set(key, { name, value, path, httpOnly });
  }

  /** The Cookie header a browser sends to `path`. */
  header(path: string) {
    return [...this.cookies.values()]
      .filter(
        // RFC 6265 path-match: the same path, or below it ("/" covers all).
        (cookie) =>
          path === cookie.path ||
          path.startsWith(
            cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`,
          ),
      )
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  get(name: string) {
    return (
      [...this.cookies.values()].find((cookie) => cookie.name === name) ?? null
    );
  }
}

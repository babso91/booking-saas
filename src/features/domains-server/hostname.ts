// A public hostname she may type (docs/SITE_DOMAIN_CONTRACT.md): lower
// case, no scheme, path, port or trailing dot; at least one dot; labels of
// letters, digits and hyphens; never an IP address. null when it is not
// one. The same rule as the screen's; the database checks it again.
export function normalizeHostname(input: string): string | null {
  let host = input.trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0]!;
  host = host.replace(/\.$/, "");
  if (host.includes(":") || host.includes("@")) return null;
  if (/^\d+(\.\d+){3}$/.test(host)) return null;
  if (host.length > 253 || !host.includes(".")) return null;
  const labels = host.split(".");
  if (
    !labels.every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label)) ||
    !/^[a-z]{2,}$/.test(labels.at(-1)!)
  ) {
    return null;
  }
  return host;
}

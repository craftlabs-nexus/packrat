/**
 * Can a web page download this pack file? A static, offline classification
 * of a download URL (no network probe): the page fetches cross-origin, so
 * the host must answer with CORS headers, must be reachable from the
 * browser, and an https page cannot fetch http:// (mixed content).
 *
 * Rules, first match wins:
 * 1. not an http(s) URL, or credentials in it -> blocked "invalid-url"
 * 2. same origin as the pack (it already loaded)  -> ok "pack-origin"
 * 3. loopback (localhost, 127/8, [::1])           -> ok "loopback"
 * 4. internal host (single label, .local, private IP, ...) -> blocked
 * 5. http:// on an https page                     -> blocked "mixed-content"
 * 6. a host known to send CORS headers            -> ok "known-host"
 * 7. a host known not to                          -> blocked "host-no-cors"
 * 8. anything else                                -> "unverified"
 * (The plan swaps a blocked URL for Modrinth's CDN copy when the file's
 * sha512 is on Modrinth: "modrinth-substitute".)
 */

export interface ClassifyContext {
  /** The page's own protocol (location.protocol), e.g. "https:" */
  pageProtocol: string;
  /** Origin the pack itself was fetched from (packwiz), e.g. "https://a.example" */
  packOrigin?: string;
}

export type BlockedReason =
  | "invalid-url"
  | "internal-host"
  | "mixed-content"
  | "host-no-cors";

export type UrlVerdict =
  | {
      kind: "ok";
      via: "pack-origin" | "loopback" | "known-host" | "modrinth-substitute";
    }
  | { kind: "unverified"; host: string }
  /** detail: the URL's host, or what is wrong with it (invalid-url) */
  | { kind: "blocked"; reason: BlockedReason; detail: string };

/** Hosts verified to send `Access-Control-Allow-Origin: *` for downloads. */
export const KNOWN_GOOD_HOSTS: readonly string[] = [
  "cdn.modrinth.com",
  "raw.githubusercontent.com",
];

/**
 * Hosts verified not to send CORS headers (or to redirect without them).
 * `pathIncludes` limits a rule to download paths of a host.
 */
export const KNOWN_BLOCKED_HOSTS: readonly { host: string; pathIncludes?: string }[] = [
  { host: "github.com", pathIncludes: "/releases/download/" },
  { host: "objects.githubusercontent.com" },
  { host: "release-assets.githubusercontent.com" },
  { host: "gitlab.com" },
  { host: "edge.forgecdn.net" },
  { host: "mediafilez.forgecdn.net" },
];

const INTERNAL_SUFFIXES = [".local", ".internal", ".lan", ".home.arpa", ".localdomain"];

/** Dotted-quad IPv4 (the URL parser normalises 0x7f.1 and friends to this). */
function ipv4Octets(hostname: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return undefined;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
}

/** An IPv4-mapped IPv6 literal ([::ffff:7f00:1]) as dotted-quad IPv4. */
function mappedIpv4(hostname: string): string | undefined {
  const m = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(hostname);
  if (!m) return undefined;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** Lowercase, without a trailing dot ("pack." is the same host as "pack"). */
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function isLoopback(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (h === "localhost" || h.endsWith(".localhost") || h === "[::1]") return true;
  const v4 = ipv4Octets(mappedIpv4(h) ?? h);
  return v4 !== undefined && v4[0] === 127;
}

/**
 * Private, link-local or unspecified IP literal: IPv4 10/8, 172.16/12,
 * 192.168/16, 169.254/16, 0/8; IPv6 ULA (fc00::/7), link-local (fe80::/10),
 * [::]. Loopback is not included (see classifyDownloadUrl).
 */
export function isPrivateIp(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  const v4 = ipv4Octets(mappedIpv4(h) ?? h);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (!h.startsWith("[")) return false;
  const v6 = h.slice(1, -1);
  return v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * A host only a local network resolves: a single-label name (`pack`,
 * a Docker service), a local-only suffix (.local, .internal, .lan,
 * .home.arpa, .localdomain) or a private IP. Expects URL.hostname (already
 * lowercased, IDN in punycode, IPv6 in brackets).
 */
export function isInternalHost(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (isPrivateIp(h)) return true;
  if (h.startsWith("[") || ipv4Octets(h)) return false;
  if (!h.includes(".")) return true;
  return INTERNAL_SUFFIXES.some((s) => h.endsWith(s));
}

/** The page's protocol; "https:" outside a browser (as in production). */
export function currentPageProtocol(): string {
  return typeof location !== "undefined" ? location.protocol : "https:";
}

/** Rule 1: an http(s) URL without credentials, else why not. */
export function parseWebUrl(
  raw: string,
):
  | { ok: true; url: URL }
  | { ok: false; problem: "not-a-url" | "scheme" | "credentials"; detail: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, problem: "not-a-url", detail: "not a URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, problem: "scheme", detail: `${url.protocol}// URL` };
  }
  // fetch() refuses URLs with credentials (TypeError)
  if (url.username || url.password) {
    return { ok: false, problem: "credentials", detail: "credentials in the URL" };
  }
  return { ok: true, url };
}

/** Rule 5: an http:// fetch from an https page (browsers block it). */
export function isMixedContent(url: URL, pageProtocol: string): boolean {
  return url.protocol === "http:" && pageProtocol === "https:" && !isLoopback(url.hostname);
}

function isKnownBlocked(url: URL): boolean {
  const host = normalizeHostname(url.hostname);
  return KNOWN_BLOCKED_HOSTS.some(
    (b) => b.host === host && (!b.pathIncludes || url.pathname.includes(b.pathIncludes)),
  );
}

export function classifyDownloadUrl(raw: string, ctx: ClassifyContext): UrlVerdict {
  const parsed = parseWebUrl(raw);
  if (!parsed.ok) return { kind: "blocked", reason: "invalid-url", detail: parsed.detail };
  const { url } = parsed;
  const host = url.host;

  if (ctx.packOrigin && url.origin === ctx.packOrigin) return { kind: "ok", via: "pack-origin" };
  if (isLoopback(url.hostname)) return { kind: "ok", via: "loopback" };
  if (isInternalHost(url.hostname)) {
    return { kind: "blocked", reason: "internal-host", detail: host };
  }
  if (isMixedContent(url, ctx.pageProtocol)) {
    return { kind: "blocked", reason: "mixed-content", detail: host };
  }
  if (KNOWN_GOOD_HOSTS.includes(normalizeHostname(url.hostname))) {
    return { kind: "ok", via: "known-host" };
  }
  if (isKnownBlocked(url)) return { kind: "blocked", reason: "host-no-cors", detail: host };
  return { kind: "unverified", host };
}

/** The row's unresolvable reason for a blocked download. */
export function describeBlockedDownload(
  verdict: Extract<UrlVerdict, { kind: "blocked" }>,
): string {
  switch (verdict.reason) {
    case "invalid-url":
      return `invalid download URL (${verdict.detail})`;
    case "internal-host":
      return `internal host ${verdict.detail} (not reachable from a web page)`;
    case "mixed-content":
      return "http:// download (blocked on an https page)";
    case "host-no-cors":
      return `${verdict.detail} doesn't allow downloads from a web page`;
  }
}

/**
 * One plan note for `count` blocked files sharing a reason and host: what
 * is wrong, not what to do about it (that is the consumer's to say).
 */
export function describeBlockedGroup(
  verdict: Extract<UrlVerdict, { kind: "blocked" }>,
  count: number,
): string {
  const one = count === 1;
  const files = `${count} file${one ? "" : "s"}`;
  switch (verdict.reason) {
    case "invalid-url":
      return `${files} ${one ? "has" : "have"} an invalid download URL (${verdict.detail}).`;
    case "internal-host":
      return `${files} on ${verdict.detail} ${one ? "is" : "are"} internal to the server (not reachable from a web page).`;
    case "mixed-content":
      return `${files} on ${verdict.detail} ${one ? "uses" : "use"} http://, which an https page can't download.`;
    case "host-no-cors":
      return `${files} on ${verdict.detail} can't be downloaded from a web page (no CORS).`;
  }
}

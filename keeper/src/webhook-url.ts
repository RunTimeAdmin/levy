import dns from "node:dns";
import { BlockList, isIP } from "node:net";

/**
 * Where a webhook may point. Merchants choose the URL and the keeper POSTs to
 * it, so without these checks anyone who can register a webhook can make the
 * server send requests into its own network (SSRF): loopback services, the
 * private network, or the cloud metadata endpoint at 169.254.169.254.
 *
 * Checked twice: when the webhook is registered (fast feedback) and on every
 * delivery, at DNS resolution time, so a hostname that later resolves to a
 * private address (DNS rebinding) is still refused. Redirects are never
 * followed. `allowPrivate` lifts the address and https rules for local
 * development and tests only.
 */
export interface WebhookUrlPolicy {
  allowPrivate: boolean;
}

// IPv4: loopback, private, link-local, carrier-grade NAT, multicast,
// documentation, 6to4 relay and reserved ranges.
const BLOCKED_V4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  BLOCKED_V4.addSubnet(net, prefix, "ipv4");
}

// IPv6 is an allowlist: global unicast (2000::/3) only. That excludes every
// form that embeds an IPv4 address outside it (::ffff:0:0/96, ::/96,
// 64:ff9b::/96, 64:ff9b:1::/48), plus loopback, link-local, ULA and site-local.
// Inside 2000::/3, the IETF special-purpose block (incl. Teredo), 6to4,
// documentation and the retired 6bone range are refused too.
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");
const SPECIAL_V6 = new BlockList();
for (const [net, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3ffe::", 16],
] as const) {
  SPECIAL_V6.addSubnet(net, prefix, "ipv6");
}

/** True for any address a webhook must not reach (and for non-IP input). */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return BLOCKED_V4.check(ip, "ipv4");
  if (family === 6) return !GLOBAL_V6.check(ip, "ipv6") || SPECIAL_V6.check(ip, "ipv6");
  return true;
}

const NOT_PUBLIC = "url must point to a public address (not private, loopback or reserved)";

/** URL.hostname keeps the brackets around IPv6 literals. */
function bareHost(u: URL): string {
  return u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
}

/**
 * Checks that need no network: scheme, credentials, IP literals. Returns the
 * reason the URL is refused, or null.
 */
export function webhookUrlProblem(u: URL, policy: WebhookUrlPolicy): string | null {
  const httpsOnly = !policy.allowPrivate;
  if (u.protocol !== "https:" && !(u.protocol === "http:" && !httpsOnly)) {
    return httpsOnly ? "url must use https" : "url must be http(s)";
  }
  if (u.username || u.password) return "url must not contain credentials";
  if (policy.allowPrivate) return null;
  // Port 443 only: any port would let a caller probe the host's own public
  // IP (which no blocklist knows) port by port.
  if (u.port !== "" && u.port !== "443") return "url must use the default https port (443)";
  const host = bareHost(u);
  if (isIP(host) && isBlockedAddress(host)) return NOT_PUBLIC;
  return null;
}

/**
 * Registration-time check, including DNS: every address the hostname resolves
 * to must be public. Returns the normalized URL, or the reason it is refused.
 */
export async function checkWebhookUrl(
  raw: unknown,
  policy: WebhookUrlPolicy
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (typeof raw !== "string") return { ok: false, error: "url must be a string" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "url is not a valid URL" };
  }
  const problem = webhookUrlProblem(u, policy);
  if (problem) return { ok: false, error: problem };
  const host = bareHost(u);
  if (!policy.allowPrivate && !isIP(host)) {
    // One message for "does not resolve" and "resolves privately", so the
    // answer cannot be used to discover internal hostnames.
    let addrs: dns.LookupAddress[] = [];
    try {
      addrs = await dns.promises.lookup(host, { all: true });
    } catch {
      addrs = [];
    }
    if (addrs.length === 0 || addrs.some((a) => isBlockedAddress(a.address))) {
      return { ok: false, error: NOT_PUBLIC };
    }
  }
  return { ok: true, url: u.href };
}

/**
 * `lookup` for http.request: resolves like dns.lookup, but fails the
 * connection when any resolved address is blocked. Runs on every delivery,
 * so it also covers DNS rebinding after registration.
 */
export function publicOnlyLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as dns.LookupAddress[];
    const blocked = list.find((a) => isBlockedAddress(a.address));
    if (blocked || list.length === 0) {
      const e: NodeJS.ErrnoException = new Error(
        `refused: ${hostname} resolves to a private or reserved address`
      );
      e.code = "EWEBHOOKBLOCKED";
      return callback(e, "", 0);
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

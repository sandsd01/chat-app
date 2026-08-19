const net = require("node:net");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");

// Ranges that must never be reachable from a user-supplied URL. 169.254/16
// earns its place twice over: it is link-local *and* it is where every major
// cloud provider parks the instance metadata endpoint that hands out
// credentials to anything that can issue a plain GET.
const BLOCKED_V4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255
];

const BLOCKED_V6 = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link local
  ["ff00::", 8], // multicast
];

function v4ToInt(ip) {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) >>> 0) + Number(octet), 0) >>> 0;
}

function inV4Range(ip, network, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((v4ToInt(ip) & mask) >>> 0) === ((v4ToInt(network) & mask) >>> 0);
}

// Expands any valid IPv6 text form (including "::" compression and a trailing
// dotted-quad) to its 16 bytes. Returns null on anything it can't parse, and
// every caller treats null as "block" rather than "allow".
function v6ToBytes(address) {
  let head = address;
  let embeddedV4 = null;

  const lastColon = address.lastIndexOf(":");
  if (lastColon === -1) return null;
  const tail = address.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!net.isIPv4(tail)) return null;
    embeddedV4 = tail;
    head = `${address.slice(0, lastColon + 1)}0:0`;
  }

  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;

  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right];
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }

  if (embeddedV4) bytes.splice(12, 4, ...embeddedV4.split(".").map(Number));
  return bytes;
}

function inV6Range(bytes, networkBytes, prefix) {
  let remaining = prefix;
  for (let i = 0; i < 16 && remaining > 0; i++) {
    const take = Math.min(8, remaining);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((bytes[i] & mask) !== (networkBytes[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

/**
 * True when this literal address must not be connected to. Fails closed:
 * anything that isn't a parseable IP is blocked, because the only callers are
 * a DNS resolver callback and a URL validator, and an address neither can
 * understand is an address neither can clear.
 */
function isBlockedAddress(address) {
  if (net.isIPv4(address)) {
    return BLOCKED_V4.some(([network, prefix]) => inV4Range(address, network, prefix));
  }
  if (net.isIPv6(address)) {
    const bytes = v6ToBytes(address);
    if (!bytes) return true;

    // ::ffff:0:0/96 is IPv4 wearing IPv6 notation. Checking it only against
    // the IPv6 table would let ::ffff:127.0.0.1 sail past every loopback rule
    // above — this unwrap is the single most-missed bypass.
    const isV4Mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (isV4Mapped) return isBlockedAddress(bytes.slice(12).join("."));

    return BLOCKED_V6.some(([network, prefix]) => inV6Range(bytes, v6ToBytes(network), prefix));
  }
  return true;
}

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 3;
const CONNECT_TIMEOUT_MS = 3000;
const TOTAL_TIMEOUT_MS = 5000;
const USER_AGENT = "ChatAppLinkPreview/1.0 (+link preview bot)";

function assertFetchableUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length > MAX_URL_LENGTH) {
    throw new Error("URL is missing or too long");
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported scheme ${url.protocol}`);
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (port !== 80 && port !== 443) throw new Error(`Unsupported port ${port}`);

  // A URL whose host is already a literal IP never reaches a DNS server, so
  // guardedLookup below is not the layer that would stop it. Check here,
  // where the address is sitting in plain sight. (URL brackets IPv6 hosts.)
  const literal = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (net.isIP(literal) && isBlockedAddress(literal)) {
    throw new Error(`Blocked address ${literal}`);
  }
  return url;
}

/**
 * Where a Location header points, re-validated from scratch.
 *
 * Its own function because this is the redirect leg of the SSRF fence and it
 * has to be testable on its own: a live-server test can't get here, since a
 * local test server is itself a blocked address.
 */
function nextRedirectUrl(location, currentUrl) {
  return assertFetchableUrl(new URL(location, currentUrl).toString());
}

/**
 * A drop-in replacement for dns.lookup that refuses to hand back an address
 * the fence rejects.
 *
 * Passing this as http.request's `lookup` option — rather than resolving the
 * hostname, checking it, and then calling fetch(url) — is the whole point. In
 * the resolve-then-fetch shape, the attacker's authoritative DNS server can
 * answer the *second* query with 127.0.0.1, and the check protected nothing.
 * Guarding the lookup the socket actually uses closes that window instead of
 * narrowing it.
 */
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length) return callback(new Error("DNS returned no addresses"));

    // Every answer must clear, not just the one we intend to use: a host that
    // resolves to one public and one private address would otherwise be
    // reachable on a retry or a round-robin reorder.
    for (const entry of addresses) {
      if (isBlockedAddress(entry.address)) {
        return callback(new Error(`Blocked address ${entry.address}`));
      }
    }

    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function readCapped(res, maxBytes, deadline) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const timer = setTimeout(
      () => {
        res.destroy();
        reject(new Error("Response timed out"));
      },
      Math.max(1, deadline - Date.now())
    );

    res.on("data", (chunk) => {
      total += chunk.length;
      // Enforced against bytes actually received, never against a
      // Content-Length header the server is free to lie about.
      if (total > maxBytes) {
        clearTimeout(timer);
        res.destroy();
        reject(new Error("Response too large"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    res.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function requestOnce(url, accept, deadline) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        headers: { "User-Agent": USER_AGENT, Accept: accept },
      },
      resolve
    );
    req.setTimeout(Math.min(CONNECT_TIMEOUT_MS, Math.max(1, deadline - Date.now())), () => {
      req.destroy(new Error("Request timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * GETs a URL through every layer of the fence, following redirects by hand so
 * each hop can be re-validated. Resolves with the FINAL url, so a caller
 * resolving relative links (an og:image path, say) resolves them against
 * where the document actually came from.
 */
async function safeGet(rawUrl, { maxBytes, allowedTypes, accept }) {
  let url = assertFetchableUrl(rawUrl);
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requestOnce(url, accept, deadline);

    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.destroy();
      if (hop === MAX_REDIRECTS) throw new Error("Too many redirects");
      // Re-validated from scratch on every hop. The origin URL clearing the
      // fence says nothing at all about where it just pointed us — a 302 to
      // http://169.254.169.254/ is the entire attack, and only this line
      // stops it.
      url = nextRedirectUrl(res.headers.location, url);
      continue;
    }

    if (res.statusCode !== 200) {
      res.destroy();
      throw new Error(`Unexpected status ${res.statusCode}`);
    }

    const contentType = String(res.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!allowedTypes.includes(contentType)) {
      res.destroy();
      throw new Error(`Unsupported content type ${contentType || "(none)"}`);
    }

    const body = await readCapped(res, maxBytes, deadline);
    return { url: url.toString(), contentType, body };
  }

  throw new Error("Too many redirects");
}

module.exports = { isBlockedAddress, assertFetchableUrl, nextRedirectUrl, readCapped, safeGet, guardedLookup };

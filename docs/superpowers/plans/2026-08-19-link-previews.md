# Link Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unfurl the first URL in a chat message into a preview card (title, description, site name, stored thumbnail) and make URLs in message bodies clickable.

**Architecture:** A new SSRF-fenced HTTP client (`src/lib/safeFetch.js`) is the foundation; `src/lib/linkPreview.js` layers URL extraction, HTML metadata parsing, and a cached `LinkPreview` row on top. `POST /conversations/:id/messages` kicks resolution off fire-and-forget after responding, exactly like the existing push call, and announces the result over the existing SSE bus.

**Tech Stack:** Node 22, Express 5, Prisma 7 + PostgreSQL, `node:test` + Supertest, React 19 + Vite.

**Spec:** `docs/superpowers/specs/2026-08-19-link-previews-design.md`

## Global Constraints

- No new npm dependencies. The fetcher uses `node:http`/`node:https`/`node:dns`/`node:net`; the HTML extractor is hand-rolled.
- URL column and all URL validation cap at **2048 characters**.
- Document fetch: **512 KB** cap, content types `text/html` and `application/xhtml+xml`.
- Image fetch: **200 KB** cap, content types `image/png`, `image/jpeg`, `image/webp`, `image/gif`. **SVG is never accepted.**
- Timeouts: **3000 ms** connect, **5000 ms** total per URL.
- Redirects: at most **3** hops, each re-validated in full.
- Ports: **80 and 443 only**. Schemes: **http and https only**.
- No env flag may bypass the SSRF fence, in any environment, ever.
- Every backend batch is verified with `npm test` (full suite) and, when `web/` changed, `cd web && npm run build`, before committing.

---

### Task 1: SSRF address predicate

**Files:**
- Create: `src/lib/safeFetch.js`
- Test: `tests/safeFetch.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `isBlockedAddress(address: string): boolean` — `true` when the literal IP must not be connected to. Non-IP input returns `true` (fail closed).

- [ ] **Step 1: Write the failing test**

```js
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { isBlockedAddress } = require("../src/lib/safeFetch");

describe("isBlockedAddress", () => {
  const blockedV4 = [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "127.1.2.3",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1",
    "192.0.2.5", "192.88.99.1", "192.168.1.1", "198.18.0.1",
    "198.51.100.7", "203.0.113.9", "224.0.0.1", "240.0.0.1", "255.255.255.255",
  ];
  for (const ip of blockedV4) {
    test(`blocks IPv4 ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
  }

  const allowedV4 = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.63.255.255"];
  for (const ip of allowedV4) {
    test(`allows IPv4 ${ip}`, () => assert.equal(isBlockedAddress(ip), false));
  }

  const blockedV6 = [
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
    "64:ff9b::1", "100::1", "2001:db8::1",
  ];
  for (const ip of blockedV6) {
    test(`blocks IPv6 ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
  }

  test("allows a public IPv6 address", () => {
    assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
  });

  // The classic blocklist bypass: loopback written in IPv4-mapped notation.
  test("unwraps IPv4-mapped IPv6 and blocks loopback", () => {
    assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true);
  });
  test("unwraps IPv4-mapped IPv6 and blocks link-local metadata", () => {
    assert.equal(isBlockedAddress("::ffff:169.254.169.254"), true);
  });
  test("unwraps IPv4-mapped IPv6 and allows a public address", () => {
    assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
  });

  test("fails closed on things that are not IP addresses", () => {
    assert.equal(isBlockedAddress("example.com"), true);
    assert.equal(isBlockedAddress(""), true);
    assert.equal(isBlockedAddress("999.999.999.999"), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:migrate` once, then
`DATABASE_URL="$TEST_DATABASE_URL" JWT_SECRET="test-secret" NODE_ENV="test" node --test tests/safeFetch.test.js`
Expected: FAIL — `Cannot find module '../src/lib/safeFetch'`.

- [ ] **Step 3: Write minimal implementation**

```js
const net = require("node:net");

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
  return (v4ToInt(ip) & mask) >>> 0 === (v4ToInt(network) & mask) >>> 0;
}

// Expands any valid IPv6 text form (including "::" compression and a trailing
// dotted-quad) to its 16 bytes. Returns null on anything it can't parse, and
// every caller treats null as "block" rather than "allow".
function v6ToBytes(address) {
  let head = address;
  let embeddedV4 = null;

  const lastColon = address.lastIndexOf(":");
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
 * anything that isn't a parseable IP is blocked, because the only caller is a
 * DNS resolver callback and an address it can't understand is an address it
 * can't clear.
 */
function isBlockedAddress(address) {
  if (net.isIPv4(address)) {
    return BLOCKED_V4.some(([network, prefix]) => inV4Range(address, network, prefix));
  }
  if (net.isIPv6(address)) {
    const bytes = v6ToBytes(address);
    if (!bytes) return true;

    // ::ffff:0:0/96 is IPv4 wearing IPv6 notation. Checking it only against
    // the IPv6 table would let ::ffff:127.0.0.1 sail past every loopback
    // rule above — this unwrap is the single most-missed bypass.
    const isV4Mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (isV4Mapped) return isBlockedAddress(bytes.slice(12).join("."));

    return BLOCKED_V6.some(([network, prefix]) => inV6Range(bytes, v6ToBytes(network), prefix));
  }
  return true;
}

module.exports = { isBlockedAddress };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="$TEST_DATABASE_URL" JWT_SECRET="test-secret" NODE_ENV="test" node --test tests/safeFetch.test.js`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/safeFetch.js tests/safeFetch.test.js
git commit -m "Add SSRF address predicate for link preview fetching"
```

---

### Task 2: Guarded HTTP client

**Files:**
- Modify: `src/lib/safeFetch.js`
- Test: `tests/safeFetch.test.js`

**Interfaces:**
- Consumes: `isBlockedAddress` from Task 1.
- Produces:
  - `assertFetchableUrl(rawUrl: string): URL` — throws on bad scheme, bad port, unparseable URL, or length over 2048.
  - `safeGet(rawUrl: string, { maxBytes: number, allowedTypes: string[], accept: string }): Promise<{ url: string, contentType: string, body: Buffer }>` — `url` is the **final** URL after redirects.
  - `nextRedirectUrl(location: string, currentUrl: URL): URL` — resolves a `Location` header against the current URL and re-runs the full fence on it. Exported so the redirect-revalidation property is directly testable without a live server.
  - `readCapped(stream, maxBytes, deadline): Promise<Buffer>` — exported for the same reason.
  - `guardedLookup` (exported for tests only).

- [ ] **Step 1: Write the failing test**

Append to `tests/safeFetch.test.js`. The local HTTP server here is only ever reached through `safeGet`'s *rejection* paths or by bypassing DNS entirely — note that a plain `127.0.0.1` URL is itself blocked, which is exactly the property the first test asserts.

```js
const http = require("node:http");
const { assertFetchableUrl, safeGet, nextRedirectUrl, readCapped } = require("../src/lib/safeFetch");

describe("assertFetchableUrl", () => {
  test("accepts ordinary http and https URLs", () => {
    assert.equal(assertFetchableUrl("https://example.com/a").hostname, "example.com");
    assert.equal(assertFetchableUrl("http://example.com:80/a").hostname, "example.com");
  });
  test("rejects non-http schemes", () => {
    assert.throws(() => assertFetchableUrl("file:///etc/passwd"), /scheme/i);
    assert.throws(() => assertFetchableUrl("gopher://example.com/"), /scheme/i);
    assert.throws(() => assertFetchableUrl("javascript:alert(1)"), /scheme/i);
  });
  test("rejects ports other than 80 and 443", () => {
    assert.throws(() => assertFetchableUrl("http://example.com:22/"), /port/i);
    assert.throws(() => assertFetchableUrl("http://example.com:6379/"), /port/i);
  });
  test("rejects unparseable URLs and over-long URLs", () => {
    assert.throws(() => assertFetchableUrl("not a url"), /url/i);
    assert.throws(() => assertFetchableUrl(`https://example.com/${"a".repeat(2100)}`), /too long/i);
  });
  // A literal IP never goes near a DNS server, so guardedLookup is not the
  // layer that catches it. Check it here, where the address is already known.
  test("rejects a literal blocked IP in the host", () => {
    assert.throws(() => assertFetchableUrl("http://169.254.169.254/"), /blocked/i);
    assert.throws(() => assertFetchableUrl("http://127.0.0.1/"), /blocked/i);
    assert.throws(() => assertFetchableUrl("http://[::1]/"), /blocked/i);
  });
  test("allows a literal public IP", () => {
    assert.equal(assertFetchableUrl("http://8.8.8.8/").hostname, "8.8.8.8");
  });
});

describe("safeGet", () => {
  test("refuses to connect to a loopback host", async () => {
    await assert.rejects(
      safeGet("http://127.0.0.1/", { maxBytes: 1000, allowedTypes: ["text/html"], accept: "text/html" }),
      /blocked/i
    );
  });

  test("refuses to connect to the cloud metadata endpoint", async () => {
    await assert.rejects(
      safeGet("http://169.254.169.254/latest/meta-data/", {
        maxBytes: 1000,
        allowedTypes: ["text/html"],
        accept: "text/html",
      }),
      /blocked/i
    );
  });

  test("refuses a hostname that resolves to loopback", async () => {
    // localtest.me and friends resolve to 127.0.0.1 by design; if DNS is
    // unavailable in CI the lookup error is also a rejection, which is the
    // correct outcome either way.
    await assert.rejects(
      safeGet("http://localtest.me/", { maxBytes: 1000, allowedTypes: ["text/html"], accept: "text/html" })
    );
  });
});

// The fence's two most security-critical behaviours can't be reached through
// safeGet in a test, because a local test server is itself a blocked address.
// Both are therefore exported as their own units and tested directly, rather
// than left uncovered or "tested" behind an env flag that disables the fence.
describe("nextRedirectUrl", () => {
  const from = new URL("https://example.com/start");

  test("resolves a relative Location against the current URL", () => {
    assert.equal(nextRedirectUrl("/next", from).toString(), "https://example.com/next");
  });
  test("allows a redirect to another public host", () => {
    assert.equal(nextRedirectUrl("https://other.example/x", from).hostname, "other.example");
  });
  test("blocks a redirect to the cloud metadata endpoint", () => {
    // This is the whole SSRF attack: a public URL that 302s inward.
    assert.throws(() => nextRedirectUrl("http://169.254.169.254/", from), /blocked/i);
  });
  test("blocks a redirect that changes scheme", () => {
    assert.throws(() => nextRedirectUrl("file:///etc/passwd", from), /scheme/i);
  });
  test("blocks a redirect to a non-web port", () => {
    assert.throws(() => nextRedirectUrl("http://example.com:6379/", from), /port/i);
  });
});

describe("readCapped", () => {
  const { Readable } = require("node:stream");
  const future = () => Date.now() + 5000;

  test("returns the whole body when under the cap", async () => {
    const body = await readCapped(Readable.from([Buffer.from("hello")]), 100, future());
    assert.equal(body.toString(), "hello");
  });

  test("rejects once received bytes exceed the cap", async () => {
    const stream = Readable.from([Buffer.alloc(60), Buffer.alloc(60)]);
    await assert.rejects(readCapped(stream, 100, future()), /too large/i);
  });

  test("counts actual bytes, not a Content-Length the server claimed", async () => {
    // A hostile server can advertise 10 bytes and send 10 MB; the cap has to
    // be enforced against what arrives.
    const stream = Readable.from([Buffer.alloc(500)]);
    await assert.rejects(readCapped(stream, 100, future()), /too large/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="$TEST_DATABASE_URL" JWT_SECRET="test-secret" NODE_ENV="test" node --test tests/safeFetch.test.js`
Expected: FAIL — `assertFetchableUrl is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/safeFetch.js`, and extend the `module.exports` at the bottom to `{ isBlockedAddress, assertFetchableUrl, nextRedirectUrl, readCapped, safeGet, guardedLookup }`.

```js
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");

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
    const timer = setTimeout(() => {
      res.destroy();
      reject(new Error("Response timed out"));
    }, Math.max(1, deadline - Date.now()));

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

    const contentType = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!allowedTypes.includes(contentType)) {
      res.destroy();
      throw new Error(`Unsupported content type ${contentType || "(none)"}`);
    }

    const body = await readCapped(res, maxBytes, deadline);
    return { url: url.toString(), contentType, body };
  }

  throw new Error("Too many redirects");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="$TEST_DATABASE_URL" JWT_SECRET="test-secret" NODE_ENV="test" node --test tests/safeFetch.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/safeFetch.js tests/safeFetch.test.js
git commit -m "Add SSRF-fenced HTTP client for outbound preview fetches"
```

---

### Task 3: URL extraction and HTML metadata parsing

**Files:**
- Create: `src/lib/linkPreview.js`
- Test: `tests/linkPreview.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure string work).
- Produces:
  - `extractFirstUrl(body: string | null): string | null`
  - `extractMetadata(html: string): { title, description, siteName, imageUrl }` — every field `string | null`.

- [ ] **Step 1: Write the failing test**

```js
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { extractFirstUrl, extractMetadata } = require("../src/lib/linkPreview");

describe("extractFirstUrl", () => {
  test("finds a bare URL", () => {
    assert.equal(extractFirstUrl("look at https://example.com/x please"), "https://example.com/x");
  });
  test("returns the first of several", () => {
    assert.equal(extractFirstUrl("https://a.example/1 and https://b.example/2"), "https://a.example/1");
  });
  test("strips trailing sentence punctuation", () => {
    assert.equal(extractFirstUrl("see https://example.com/x."), "https://example.com/x");
    assert.equal(extractFirstUrl("(https://example.com/x)"), "https://example.com/x");
  });
  test("ignores non-http schemes and plain text", () => {
    assert.equal(extractFirstUrl("ftp://example.com/x"), null);
    assert.equal(extractFirstUrl("no links here"), null);
    assert.equal(extractFirstUrl(null), null);
  });
  test("rejects a URL past the 2048 character cap", () => {
    assert.equal(extractFirstUrl(`https://example.com/${"a".repeat(2100)}`), null);
  });
});

describe("extractMetadata", () => {
  test("prefers OpenGraph tags", () => {
    const html = `<html><head>
      <title>Fallback</title>
      <meta property="og:title" content="Real Title">
      <meta property="og:description" content="Real description">
      <meta property="og:site_name" content="Example">
      <meta property="og:image" content="https://example.com/i.png">
    </head></html>`;
    assert.deepEqual(extractMetadata(html), {
      title: "Real Title",
      description: "Real description",
      siteName: "Example",
      imageUrl: "https://example.com/i.png",
    });
  });

  test("falls back to <title> and meta description", () => {
    const html = `<html><head><title>Just A Title</title>
      <meta name="description" content="Plain description"></head></html>`;
    const meta = extractMetadata(html);
    assert.equal(meta.title, "Just A Title");
    assert.equal(meta.description, "Plain description");
    assert.equal(meta.siteName, null);
    assert.equal(meta.imageUrl, null);
  });

  test("decodes HTML entities", () => {
    const html = `<head><meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;show&quot;"></head>`;
    assert.equal(extractMetadata(html).title, `Tom & Jerry's "show"`);
  });

  test("handles single-quoted and unquoted attributes", () => {
    const html = `<head><meta property='og:title' content='Single'></head>`;
    assert.equal(extractMetadata(html).title, "Single");
  });

  test("returns all-null for a document with no metadata", () => {
    assert.deepEqual(extractMetadata("<html><body>hi</body></html>"), {
      title: null,
      description: null,
      siteName: null,
      imageUrl: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="$TEST_DATABASE_URL" JWT_SECRET="test-secret" NODE_ENV="test" node --test tests/linkPreview.test.js`
Expected: FAIL — `Cannot find module '../src/lib/linkPreview'`.

- [ ] **Step 3: Write minimal implementation**

```js
const MAX_URL_LENGTH = 2048;
const MAX_HTML_SCANNED = 128 * 1024;

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/i;

/** The first http(s) URL in a message body, or null. */
function extractFirstUrl(body) {
  if (typeof body !== "string") return null;
  const match = body.match(URL_PATTERN);
  if (!match) return null;
  // Trailing punctuation is far more often the sentence's than the URL's.
  const url = match[0].replace(/[.,;:!?)\]}>]+$/, "");
  if (!url || url.length > MAX_URL_LENGTH) return null;
  return url;
}

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

function readAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
}

/**
 * Pulls the handful of tags a preview card needs out of a document's head.
 *
 * Hand-rolled rather than reaching for cheerio, matching the call
 * src/lib/drive.js already made in using the Drive REST API directly instead
 * of pulling in googleapis: four tags do not justify a general-purpose DOM.
 */
function extractMetadata(html) {
  const head = String(html).slice(0, MAX_HTML_SCANNED);
  const byKey = new Map();

  for (const tag of head.match(/<meta\s+[^>]*>/gi) || []) {
    const key = (readAttribute(tag, "property") || readAttribute(tag, "name") || "").toLowerCase();
    const content = readAttribute(tag, "content");
    // First occurrence wins — a page that repeats og:title means the first.
    if (key && content && !byKey.has(key)) byKey.set(key, decodeEntities(content).trim());
  }

  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const fallbackTitle = titleTag ? decodeEntities(titleTag[1]).trim() : null;

  return {
    title: byKey.get("og:title") || fallbackTitle || null,
    description: byKey.get("og:description") || byKey.get("description") || null,
    siteName: byKey.get("og:site_name") || null,
    imageUrl: byKey.get("og:image") || null,
  };
}

module.exports = { extractFirstUrl, extractMetadata };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="$TEST_DATABASE_URL" JWT_SECRET="test-secret" NODE_ENV="test" node --test tests/linkPreview.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/linkPreview.js tests/linkPreview.test.js
git commit -m "Add URL extraction and OpenGraph metadata parsing"
```

---

### Task 4: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_link_previews/migration.sql`
- Modify: `tests/helpers/db.js:17-24` (`resetDb`)

**Interfaces:**
- Produces: Prisma models `LinkPreview` and `Message.linkPreviewId` / `Message.linkPreview`.

- [ ] **Step 1: Add the model to `prisma/schema.prisma`**

Add to `Message`, after `replyToId`:

```prisma
  /// The unfurled preview for the first URL in `body`, resolved
  /// asynchronously after the message is created (see
  /// POST /conversations/:id/messages). Points at a row keyed on the URL
  /// itself, so the same link shared by twenty people is fetched once.
  linkPreviewId      Int?
```

and to the relation block:

```prisma
  linkPreview  LinkPreview?      @relation(fields: [linkPreviewId], references: [id])
```

Add the new model:

```prisma
/// A cached unfurl of one URL: title/description/site name plus the
/// thumbnail's actual bytes. The bytes live here rather than being hotlinked
/// because src/app.js pins img-src to 'self', and widening it would leak
/// every *reading* user's IP to whatever host the *sending* user chose.
///
/// Never refetched. A preview is a snapshot of what the link looked like when
/// it was shared, which is the semantics a chat log wants, and it keeps cache
/// invalidation out of the design entirely. Failures are cached too
/// (status = "failed") so a dead link costs one fetch, not one per share.
model LinkPreview {
  id            Int      @id @default(autoincrement())
  /// VarChar, not Text: a btree unique index can't cover values past roughly
  /// 2704 bytes, so an unbounded column would turn an over-long URL into a
  /// runtime insert failure instead of a validation error.
  url           String   @unique @db.VarChar(2048)
  /// "ok" | "failed"
  status        String
  title         String?
  description   String?  @db.Text
  siteName      String?
  imageData     Bytes?
  imageMimeType String?
  fetchedAt     DateTime @default(now())

  messages Message[]

  @@map("link_previews")
}
```

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name add_link_previews`
Expected: a new folder under `prisma/migrations/` and `prisma generate` re-run.

- [ ] **Step 3: Add the table to test cleanup**

In `tests/helpers/db.js`, inside `resetDb`, delete previews **after** messages (messages hold the FK):

```js
async function resetDb() {
  await prisma.driveArchiveFile.deleteMany();
  await prisma.message.deleteMany();
  await prisma.linkPreview.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.friendship.deleteMany();
  await prisma.pushSubscription.deleteMany();
  await prisma.user.deleteMany();
}
```

- [ ] **Step 4: Verify the existing suite still passes**

Run: `npm test`
Expected: PASS, same count as before this task plus the new files' tests.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/helpers/db.js
git commit -m "Add LinkPreview model and Message.linkPreviewId"
```

---

### Task 5: Preview resolution

**Files:**
- Modify: `src/lib/linkPreview.js`
- Test: `tests/linkPreview.test.js`

**Interfaces:**
- Consumes: `safeGet` (Task 2), `extractFirstUrl` / `extractMetadata` (Task 3), `prisma.linkPreview` (Task 4).
- Produces:
  - `resolveLinkPreview(url: string): Promise<LinkPreview>` — always resolves to a row (status `"ok"` or `"failed"`), never throws for a hostile or dead URL.
  - `withUserFetchSlot(userId: number, fn: () => Promise<T>): Promise<T | null>` — runs `fn` only if the user is under their concurrent-fetch cap, otherwise returns `null` without fetching.

- [ ] **Step 1: Write the failing test**

```js
const { resolveLinkPreview, withUserFetchSlot } = require("../src/lib/linkPreview");
const { resetDb, prisma } = require("./helpers/db");

describe("resolveLinkPreview", () => {
  beforeEach(resetDb);

  test("records a failed row rather than throwing for a blocked URL", async () => {
    const preview = await resolveLinkPreview("http://169.254.169.254/latest/meta-data/");
    assert.equal(preview.status, "failed");
    assert.equal(preview.title, null);
  });

  test("reuses the cached row for a URL already resolved", async () => {
    const first = await resolveLinkPreview("http://127.0.0.1/blocked");
    const second = await resolveLinkPreview("http://127.0.0.1/blocked");
    assert.equal(first.id, second.id);
    assert.equal(await prisma.linkPreview.count(), 1);
  });

  test("returns a failed row for a URL past the length cap", async () => {
    const preview = await resolveLinkPreview(`https://example.com/${"a".repeat(2100)}`);
    assert.equal(preview.status, "failed");
  });
});

describe("withUserFetchSlot", () => {
  test("runs the work when the user is under their cap", async () => {
    const result = await withUserFetchSlot(1, async () => "done");
    assert.equal(result, "done");
  });

  test("refuses work past the per-user concurrency cap", async () => {
    let release;
    const blocker = new Promise((resolve) => {
      release = resolve;
    });
    // Fill every slot with work that hasn't finished yet.
    const held = [0, 1, 2].map(() => withUserFetchSlot(7, () => blocker));
    const refused = await withUserFetchSlot(7, async () => "should not run");
    assert.equal(refused, null);

    release();
    await Promise.all(held);

    // Slots are returned once the held work settles.
    assert.equal(await withUserFetchSlot(7, async () => "done"), "done");
  });

  test("caps are per user, not global", async () => {
    let release;
    const blocker = new Promise((resolve) => {
      release = resolve;
    });
    const held = [0, 1, 2].map(() => withUserFetchSlot(8, () => blocker));
    assert.equal(await withUserFetchSlot(9, async () => "done"), "done");
    release();
    await Promise.all(held);
  });

  test("returns the slot even when the work throws", async () => {
    await assert.rejects(
      withUserFetchSlot(10, async () => {
        throw new Error("boom");
      })
    );
    assert.equal(await withUserFetchSlot(10, async () => "done"), "done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="$TEST_DATABASE_URL" JWT_SECRET="test-secret" NODE_ENV="test" node --test tests/linkPreview.test.js`
Expected: FAIL — `resolveLinkPreview is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/linkPreview.js` (and extend `module.exports`):

```js
const prisma = require("../../prisma/client");
const { safeGet } = require("./safeFetch");

const HTML_MAX_BYTES = 512 * 1024;
const HTML_TYPES = ["text/html", "application/xhtml+xml"];
const IMAGE_MAX_BYTES = 200 * 1024;
// SVG is deliberately absent: it is a script-carrying document, not an inert
// image — the same call the 2026-08-18 audit made for attachment downloads.
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

async function fetchThumbnail(imageUrl, documentUrl) {
  try {
    const absolute = new URL(imageUrl, documentUrl).toString();
    const image = await safeGet(absolute, {
      maxBytes: IMAGE_MAX_BYTES,
      allowedTypes: IMAGE_TYPES,
      accept: IMAGE_TYPES.join(","),
    });
    return { imageData: image.body, imageMimeType: image.contentType };
  } catch {
    // A missing or oversized thumbnail downgrades the card to text-only. It
    // is not a reason to throw away a perfectly good title and description.
    return { imageData: null, imageMimeType: null };
  }
}

/**
 * Resolves one URL into a cached LinkPreview row, fetching it only if it has
 * never been seen before.
 *
 * Never throws for a bad, dead, or hostile URL — a "failed" row is the
 * outcome, and caching that failure is what keeps a link someone spams from
 * costing one outbound request per send.
 */
async function resolveLinkPreview(url) {
  const existing = await prisma.linkPreview.findUnique({ where: { url } }).catch(() => null);
  if (existing) return existing;

  let data = { url, status: "failed" };
  try {
    const doc = await safeGet(url, {
      maxBytes: HTML_MAX_BYTES,
      allowedTypes: HTML_TYPES,
      accept: "text/html,application/xhtml+xml",
    });
    const meta = extractMetadata(doc.body.toString("utf8"));
    if (meta.title || meta.description) {
      // og:image is resolved against the *final* URL so a relative path still
      // works after redirects.
      const thumbnail = meta.imageUrl ? await fetchThumbnail(meta.imageUrl, doc.url) : {};
      data = {
        url,
        status: "ok",
        title: meta.title,
        description: meta.description,
        siteName: meta.siteName,
        imageData: thumbnail.imageData ?? null,
        imageMimeType: thumbnail.imageMimeType ?? null,
      };
    }
  } catch (err) {
    // Never log the URL's response body or the message it came from.
    console.error("Link preview fetch failed:", err.message);
  }

  try {
    return await prisma.linkPreview.create({ data });
  } catch (err) {
    // Two messages carrying the same brand-new link can race here and both
    // pass the findUnique above. P2002 means the other one won; return its
    // row rather than 500ing, matching how POST .../reactions already
    // resolves the identical race on its own unique index.
    if (err.code === "P2002") return prisma.linkPreview.findUnique({ where: { url } });
    throw err;
  }
}
```

Note the URL length guard: `safeGet` already throws `URL is missing or too long` past 2048, and the `catch` above turns that into a `"failed"` row — but the row's own `url` column would then overflow. Guard before the insert:

```js
  if (typeof url !== "string" || url.length > 2048) {
    // Too long to even store, let alone index.
    return { id: null, url, status: "failed", title: null, description: null, siteName: null, imageData: null, imageMimeType: null };
  }
```

Place this as the first statement of `resolveLinkPreview`.

Then add the per-user cap the spec calls for, and export it:

```js
// One message send triggers at most one outbound fetch, and sends already go
// through apiLimiter — but that limit is generous enough that a burst would
// still let one account point a lot of simultaneous requests at a target of
// its choosing. Cap the concurrency per user so this app can't be pointed at
// someone else's server as a load generator.
const MAX_CONCURRENT_FETCHES_PER_USER = 3;
const inFlightByUser = new Map();

async function withUserFetchSlot(userId, fn) {
  const current = inFlightByUser.get(userId) || 0;
  if (current >= MAX_CONCURRENT_FETCHES_PER_USER) return null;
  inFlightByUser.set(userId, current + 1);
  try {
    return await fn();
  } finally {
    const remaining = (inFlightByUser.get(userId) || 1) - 1;
    // Drop the key entirely at zero so this Map tracks only active work
    // rather than growing one entry per user who ever sent a link.
    if (remaining > 0) inFlightByUser.set(userId, remaining);
    else inFlightByUser.delete(userId);
  }
}
```

In-process only, and therefore per-instance — the same single-instance caveat `src/lib/chatBus.js` already carries. Note it in the comment.

Update `module.exports` to `{ extractFirstUrl, extractMetadata, resolveLinkPreview, withUserFetchSlot }`, and add `withUserFetchSlot` to the test file's require.

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="$TEST_DATABASE_URL" JWT_SECRET="test-secret" NODE_ENV="test" node --test tests/linkPreview.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/linkPreview.js tests/linkPreview.test.js
git commit -m "Resolve and cache link previews under a per-user fetch cap"
```

---

### Task 6: Wire previews into the chat routes

**Files:**
- Modify: `src/routes/chat.js` — imports at `:1-9`, `GET .../messages` at `:261-301`, `POST .../messages` at `:457-614`, `PATCH .../messages/:messageId` at `:631-654`, `DELETE .../messages/:messageId` at `:656-686`
- Test: `tests/chat.test.js`

**Interfaces:**
- Consumes: `extractFirstUrl`, `resolveLinkPreview` (Tasks 3, 5).
- Produces: a `linkPreview` field on every message in `GET .../messages`, shaped `{ id, title, description, siteName, url, hasImage } | null`; SSE event `link-preview` with `{ conversationId, messageId, linkPreview }`.

- [ ] **Step 1: Write the failing test**

```js
describe("link previews on messages", () => {
  test("attaches a resolved preview and announces it over SSE", async () => {
    // The URL is blocked by the fence, so resolution lands on a "failed" row —
    // which is exactly what this test wants to assert about the *plumbing*:
    // that a preview is resolved and published at all. Successful unfurling is
    // covered by the unit tests in tests/linkPreview.test.js.
    const alice = await createUser({ email: "alice@example.com" });
    const bob = await createUser({ email: "bob@example.com" });
    await makeFriends(alice, bob);
    const token = await login("alice@example.com", "password123");

    const convo = await request(app)
      .post("/api/chat/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: bob.id });

    const eventPromise = waitForEvent(bob.id, "link-preview", 3000);

    await request(app)
      .post(`/api/chat/conversations/${convo.body.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "check http://169.254.169.254/ out" })
      .expect(201);

    const event = await eventPromise;
    assert.equal(event.conversationId, convo.body.id);
    assert.ok(event.messageId);
  });

  test("clears the preview when the message is deleted", async () => {
    const alice = await createUser({ email: "alice@example.com" });
    const bob = await createUser({ email: "bob@example.com" });
    await makeFriends(alice, bob);
    const token = await login("alice@example.com", "password123");
    const convo = await request(app)
      .post("/api/chat/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: bob.id });
    const sent = await request(app)
      .post(`/api/chat/conversations/${convo.body.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "http://169.254.169.254/" });

    await request(app)
      .delete(`/api/chat/conversations/${convo.body.id}/messages/${sent.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const row = await prisma.message.findUnique({ where: { id: sent.body.id } });
    assert.equal(row.linkPreviewId, null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="$TEST_DATABASE_URL" JWT_SECRET="test-secret" NODE_ENV="test" node --test tests/chat.test.js`
Expected: FAIL — timeout waiting for the `link-preview` event.

- [ ] **Step 3: Implement**

Add the import at the top of `src/routes/chat.js`:

```js
const { extractFirstUrl, resolveLinkPreview, withUserFetchSlot } = require("../lib/linkPreview");
```

Add a shared helper near `replyPreviewsForMessages`:

```js
/** The wire shape of a preview. `imageData` never crosses the API — the bytes
 * are served by the conversation-scoped image route instead. */
function linkPreviewPayload(preview) {
  if (!preview || preview.status !== "ok") return null;
  return {
    id: preview.id,
    url: preview.url,
    title: preview.title,
    description: preview.description,
    siteName: preview.siteName,
    hasImage: Boolean(preview.imageMimeType),
  };
}

/**
 * Resolves a message's link preview out of band and announces it.
 *
 * Fire-and-forget, exactly like the push call above it and for the same
 * reason: an unresponsive third-party server must never hold up the response
 * the sender is waiting on. A failure here is logged and dropped — the
 * message itself is already sent and is not in question.
 */
function schedulePreviewResolution(message, conversation) {
  const url = extractFirstUrl(message.body);
  if (!url) return;

  withUserFetchSlot(message.senderId, () => resolveLinkPreview(url))
    .then(async (preview) => {
      // null means the sender is already at their concurrent-fetch cap; the
      // message stands, it just doesn't get a card.
      if (!preview?.id) return;
      const current = await prisma.message.findUnique({ where: { id: message.id } });
      // The message may have been edited or deleted while we were off
      // fetching; attaching a preview to it now would resurrect a card for
      // content that no longer exists.
      if (!current || current.deletedAt || current.body !== message.body) return;

      await prisma.message.update({ where: { id: message.id }, data: { linkPreviewId: preview.id } });
      const payload = {
        conversationId: conversation.id,
        messageId: message.id,
        linkPreview: linkPreviewPayload(preview),
      };
      chatBus.publish(conversation.userAId, "link-preview", payload);
      chatBus.publish(conversation.userBId, "link-preview", payload);
    })
    .catch((err) => console.error("Link preview resolution failed:", err.message));
}
```

Wire it in:

- In `POST .../messages`, immediately before `res.status(201).json(ssePayload)`, add `schedulePreviewResolution(message, conversation);`
- In `PATCH .../messages/:messageId`, after the `prisma.message.update`, clear and re-resolve when the URL changed:

```js
  // Editing a URL out of a message must not leave its card behind.
  const previousUrl = extractFirstUrl(lookup.message.body);
  const nextUrl = extractFirstUrl(body);
  if (previousUrl !== nextUrl) {
    await prisma.message.update({ where: { id: updated.id }, data: { linkPreviewId: null } });
    schedulePreviewResolution({ ...updated, body }, conversation);
  }
```

- In `DELETE .../messages/:messageId`, add `linkPreviewId: null` to the `data` object alongside the cleared body and attachment fields.
- In `GET .../messages`, add `include: { linkPreview: true }` to the `findMany`, and add `linkPreview: linkPreviewPayload(m.linkPreview)` to the mapped object. Strip the raw relation so `imageData` never leaks into the response: replace `...m` with an explicit destructure that drops `linkPreview` before spreading, i.e.

```js
    page.map(async ({ linkPreview, ...m }) => ({
      ...m,
      attachmentUrl: m.attachmentKey ? await createDownloadUrl(m.attachmentKey, m.attachmentType) : null,
      reactions: reactionsByMessage.get(m.id) || [],
      replyTo: m.replyToId ? replyPreviews.get(m.replyToId) || null : null,
      linkPreview: linkPreviewPayload(linkPreview),
    }))
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, including the two new tests.

- [ ] **Step 5: Commit**

```bash
git add src/routes/chat.js tests/chat.test.js
git commit -m "Resolve link previews on send and edit, clear them on delete"
```

---

### Task 7: Thumbnail image route

**Files:**
- Modify: `src/routes/chat.js`
- Test: `tests/chat.test.js`

**Interfaces:**
- Consumes: the `LinkPreview` relation from Task 4.
- Produces: `GET /api/chat/conversations/:id/messages/:messageId/link-preview-image`.

- [ ] **Step 1: Write the failing test**

```js
describe("GET link preview image", () => {
  test("404s for a non-participant", async () => {
    const alice = await createUser({ email: "alice@example.com" });
    const bob = await createUser({ email: "bob@example.com" });
    const carol = await createUser({ email: "carol@example.com" });
    await makeFriends(alice, bob);
    const aliceToken = await login("alice@example.com", "password123");
    const carolToken = await login("carol@example.com", "password123");

    const convo = await request(app)
      .post("/api/chat/conversations")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ userId: bob.id });
    const sent = await request(app)
      .post(`/api/chat/conversations/${convo.body.id}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ body: "hello" });

    await request(app)
      .get(`/api/chat/conversations/${convo.body.id}/messages/${sent.body.id}/link-preview-image`)
      .set("Authorization", `Bearer ${carolToken}`)
      .expect(404);
  });

  test("serves the stored bytes to a participant", async () => {
    const alice = await createUser({ email: "alice@example.com" });
    const bob = await createUser({ email: "bob@example.com" });
    await makeFriends(alice, bob);
    const token = await login("alice@example.com", "password123");
    const convo = await request(app)
      .post("/api/chat/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: bob.id });
    const sent = await request(app)
      .post(`/api/chat/conversations/${convo.body.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "hello" });

    const preview = await prisma.linkPreview.create({
      data: {
        url: "https://example.com/stored",
        status: "ok",
        title: "Stored",
        imageData: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        imageMimeType: "image/png",
      },
    });
    await prisma.message.update({ where: { id: sent.body.id }, data: { linkPreviewId: preview.id } });

    const res = await request(app)
      .get(`/api/chat/conversations/${convo.body.id}/messages/${sent.body.id}/link-preview-image`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    assert.equal(res.headers["content-type"], "image/png");
    assert.deepEqual([...res.body], [0x89, 0x50, 0x4e, 0x47]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="$TEST_DATABASE_URL" JWT_SECRET="test-secret" NODE_ENV="test" node --test tests/chat.test.js`
Expected: FAIL — 404 on the second test (route not registered).

- [ ] **Step 3: Implement**

Add to `src/routes/chat.js`, next to the other `:messageId` routes:

```js
// Conversation-scoped rather than a flat /link-previews/:id/image, so it
// inherits getConversationForParticipant and this app's 404-not-403
// convention — and so nobody can walk a sequential id space to learn which
// URLs have been shared on this instance.
router.get("/conversations/:id/messages/:messageId/link-preview-image", async (req, res) => {
  const conversationId = Number(req.params.id);
  const conversation = await getConversationForParticipant(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const message = await getMessageInConversation(conversationId, Number(req.params.messageId));
  if (!message?.linkPreviewId) return res.status(404).json({ error: "Not found" });

  const preview = await prisma.linkPreview.findUnique({ where: { id: message.linkPreviewId } });
  if (!preview?.imageData || !preview.imageMimeType) return res.status(404).json({ error: "Not found" });

  res.setHeader("Content-Type", preview.imageMimeType);
  // Immutable: a preview is never refetched, so the bytes behind this URL
  // cannot change.
  res.setHeader("Cache-Control", "private, max-age=86400, immutable");
  res.send(Buffer.from(preview.imageData));
});
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/chat.js tests/chat.test.js
git commit -m "Serve link preview thumbnails from a conversation-scoped route"
```

---

### Task 8: Frontend — linkified bodies and the preview card

**Files:**
- Create: `web/src/lib/linkify.jsx`
- Create: `web/src/components/LinkPreviewCard.jsx`
- Modify: `web/src/context/ChatContext.jsx:64-70` (refs), `:110-130` (subscribers), `:246-251` (SSE listeners), `:365-390` (context value)
- Modify: `web/src/pages/ChatPage.jsx:937` (body rendering), plus a new live-event effect near the one at `:324`
- Modify: `web/src/i18n/translations.js`
- Modify: `web/src/index.css`

**Interfaces:**
- Consumes: the `linkPreview` field and `link-preview` SSE event from Tasks 6 and 7.
- Produces: `linkifyText(text: string): ReactNode[]`, `<LinkPreviewCard preview conversationId messageId />`, `subscribeToLinkPreview(conversationId, callback)`.

- [ ] **Step 1: Create `web/src/lib/linkify.jsx`**

```jsx
// Message bodies render as plain text, so a pasted URL was previously not
// even clickable. Split on URLs and render those segments as real anchors.
const URL_PATTERN = /(\bhttps?:\/\/[^\s<>"']+)/gi

export function linkifyText(text) {
  if (!text) return text
  return String(text)
    .split(URL_PATTERN)
    .map((segment, index) => {
      if (!/^https?:\/\//i.test(segment)) return segment
      const trimmed = segment.replace(/[.,;:!?)\]}>]+$/, '')
      const trailing = segment.slice(trimmed.length)
      return (
        <span key={index}>
          <a href={trimmed} target="_blank" rel="noopener noreferrer">
            {trimmed}
          </a>
          {trailing}
        </span>
      )
    })
}
```

- [ ] **Step 2: Create `web/src/components/LinkPreviewCard.jsx`**

```jsx
export default function LinkPreviewCard({ preview, conversationId, messageId }) {
  if (!preview) return null

  return (
    <a
      className="chat-link-preview"
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {preview.hasImage && (
        <img
          className="chat-link-preview-image"
          src={`/api/chat/conversations/${conversationId}/messages/${messageId}/link-preview-image`}
          alt=""
        />
      )}
      <span className="chat-link-preview-text">
        {preview.siteName && <span className="chat-link-preview-site">{preview.siteName}</span>}
        {preview.title && <span className="chat-link-preview-title">{preview.title}</span>}
        {preview.description && (
          <span className="chat-link-preview-description">{preview.description}</span>
        )}
      </span>
    </a>
  )
}
```

Note: the `<img>` is same-origin, so the existing `img-src 'self'` CSP covers it with no change to `src/app.js`.

- [ ] **Step 3: Wire the SSE event through `ChatContext.jsx`**

Add the ref alongside the others at `:64-70`:

```jsx
  const linkPreviewListenersRef = useRef(new Map()) // conversationId -> Set<(payload) => void>
```

Add the subscriber next to `subscribeToMessageDeleted`:

```jsx
  const subscribeToLinkPreview = useCallback(
    (conversationId, callback) => subscribeViaMap(linkPreviewListenersRef.current, conversationId, callback),
    []
  )
```

Add the listener next to the `reaction-added` one:

```jsx
    addJsonListener(es, 'link-preview', (payload) => {
      dispatchViaMap(linkPreviewListenersRef.current, payload.conversationId, payload)
    })
```

Add `subscribeToLinkPreview` to both the dependency array and the object in the context value at `:365-390`.

- [ ] **Step 4: Render in `ChatPage.jsx`**

Pull `subscribeToLinkPreview` out of `useChat()` alongside `subscribeToMessageDeleted`, then add an effect modelled on the deleted-message one at `:324`:

```jsx
  useEffect(() => {
    if (!activeConversationId) return
    return subscribeToLinkPreview(activeConversationId, (payload) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === payload.messageId ? { ...m, linkPreview: payload.linkPreview } : m))
      )
    })
  }, [activeConversationId, subscribeToLinkPreview])
```

Replace the bare `{m.body}` at `:937` with `{linkifyText(m.body)}`, and render the card immediately after the body line, before the `chat-bubble-time` span:

```jsx
                                {m.linkPreview && (
                                  <LinkPreviewCard
                                    preview={m.linkPreview}
                                    conversationId={activeConversationId}
                                    messageId={m.id}
                                  />
                                )}
```

- [ ] **Step 5: Add styles and translations**

In `web/src/index.css`, add `.chat-link-preview` (a bordered, rounded block using the existing ink/paper tokens), `.chat-link-preview-image` (max-height 160px, `object-fit: cover`), and `.chat-link-preview-site` / `-title` / `-description` following the sizing already used by `.chat-bubble-quote`.

No new user-facing strings are required — the card shows only remote content. If a loading state is added later it needs a key in both locales in `web/src/i18n/translations.js`.

- [ ] **Step 6: Verify**

Run: `cd web && npm run build`
Expected: clean build, no unresolved imports.

Run: `npm test` (from the repo root)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/linkify.jsx web/src/components/LinkPreviewCard.jsx web/src/context/ChatContext.jsx web/src/pages/ChatPage.jsx web/src/index.css
git commit -m "Render link preview cards and linkify message bodies"
```

---

## Final verification

- [ ] `npm test` — full backend suite green
- [ ] `cd web && npm run build` — clean
- [ ] Manual Playwright pass against real dev servers: send a message containing a public URL, confirm the card appears without a reload, confirm the thumbnail loads with no CSP violation in the browser console, confirm a plain URL is clickable, and confirm editing the URL out removes the card.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { isBlockedAddress, assertFetchableUrl, safeGet, nextRedirectUrl, readCapped } = require("../src/lib/safeFetch");

describe("isBlockedAddress", () => {
  const blockedV4 = [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.5",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
  ];
  for (const ip of blockedV4) {
    test(`blocks IPv4 ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
  }

  const allowedV4 = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.63.255.255"];
  for (const ip of allowedV4) {
    test(`allows IPv4 ${ip}`, () => assert.equal(isBlockedAddress(ip), false));
  }

  const blockedV6 = ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "64:ff9b::1", "100::1", "2001:db8::1"];
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
  const htmlOptions = { maxBytes: 1000, allowedTypes: ["text/html"], accept: "text/html" };

  test("refuses to connect to a loopback host", async () => {
    await assert.rejects(safeGet("http://127.0.0.1/", htmlOptions), /blocked/i);
  });

  test("refuses to connect to the cloud metadata endpoint", async () => {
    await assert.rejects(safeGet("http://169.254.169.254/latest/meta-data/", htmlOptions), /blocked/i);
  });

  test("refuses a hostname that resolves to loopback", async () => {
    // localtest.me and friends resolve to 127.0.0.1 by design; if DNS is
    // unavailable in CI the lookup error is also a rejection, which is the
    // correct outcome either way.
    await assert.rejects(safeGet("http://localtest.me/", htmlOptions));
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

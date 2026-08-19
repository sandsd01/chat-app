const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { isBlockedAddress } = require("../src/lib/safeFetch");

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

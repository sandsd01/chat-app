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

module.exports = { isBlockedAddress };

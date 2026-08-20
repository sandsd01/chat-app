const prisma = require("../../prisma/client");
const { safeGet } = require("./safeFetch");

const MAX_URL_LENGTH = 2048;
// Matches HTML_MAX_BYTES below on purpose: downloading bytes we then refuse
// to look at would be pure waste, and scanning past what we downloaded is
// impossible. One number, no silent gap between the two.
const MAX_HTML_SCANNED = 512 * 1024;

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
        entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
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
  if (typeof url !== "string" || url.length > MAX_URL_LENGTH) {
    // Too long to even store, let alone index. Returned rather than thrown so
    // callers have one shape to handle; the null id marks it unsaved.
    return {
      id: null,
      url,
      status: "failed",
      title: null,
      description: null,
      siteName: null,
      imageData: null,
      imageMimeType: null,
    };
  }

  const existing = await prisma.linkPreview.findUnique({ where: { url } });
  if (existing) return existing;

  let data = { url, status: "failed" };
  try {
    const doc = await safeGet(url, {
      maxBytes: HTML_MAX_BYTES,
      allowedTypes: HTML_TYPES,
      accept: "text/html,application/xhtml+xml",
      // Stop at the cap and parse what arrived rather than rejecting the
      // page: the tags we want are in the head, and plenty of ordinary sites
      // ship more than half a megabyte of markup.
      truncate: true,
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
    // Never log the URL's response body, nor the message it came from.
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

// One message send triggers at most one outbound fetch, and sends already go
// through apiLimiter — but that limit is generous enough that a burst would
// still let one account point a lot of simultaneous requests at a target of
// its choosing. Cap the concurrency per user so this app can't be pointed at
// someone else's server as a load generator. In-process, and therefore
// per-instance: the same single-instance caveat src/lib/chatBus.js carries.
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

module.exports = { extractFirstUrl, extractMetadata, resolveLinkPreview, withUserFetchSlot };

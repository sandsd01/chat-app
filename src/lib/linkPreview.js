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

module.exports = { extractFirstUrl, extractMetadata };

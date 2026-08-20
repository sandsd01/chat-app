const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
// Required before src/lib/linkPreview, which pulls in prisma/client — that
// module throws at require time on an unset DATABASE_URL, and this helper is
// what sets it. Same ordering as every other test file here.
const { resetDb, prisma } = require("./helpers/db");
const {
  extractFirstUrl,
  extractMetadata,
  resolveLinkPreview,
  withUserFetchSlot,
} = require("../src/lib/linkPreview");

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

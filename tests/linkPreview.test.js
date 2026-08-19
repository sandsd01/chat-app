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

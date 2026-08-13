const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { validateUpload, attachmentTypeFor, keyFor, MAX_IMAGE_BYTES, MAX_FILE_BYTES } = require("../src/lib/attachments");

describe("src/lib/attachments.js#attachmentTypeFor", () => {
  test("classifies an image/* mime type as image", () => {
    assert.equal(attachmentTypeFor("image/png"), "image");
  });

  test("classifies anything else as file", () => {
    assert.equal(attachmentTypeFor("application/pdf"), "file");
  });
});

describe("src/lib/attachments.js#validateUpload", () => {
  test("accepts an image under the image size limit", () => {
    const type = validateUpload({ fileName: "photo.jpg", mimeType: "image/jpeg", size: MAX_IMAGE_BYTES - 1 });
    assert.equal(type, "image");
  });

  test("rejects an image over the image size limit", () => {
    assert.throws(() => validateUpload({ fileName: "photo.jpg", mimeType: "image/jpeg", size: MAX_IMAGE_BYTES + 1 }));
  });

  test("accepts a non-image file under the file size limit", () => {
    const type = validateUpload({ fileName: "report.pdf", mimeType: "application/pdf", size: MAX_FILE_BYTES - 1 });
    assert.equal(type, "file");
  });

  test("rejects a non-image file over the file size limit", () => {
    assert.throws(() =>
      validateUpload({ fileName: "report.pdf", mimeType: "application/pdf", size: MAX_FILE_BYTES + 1 })
    );
  });

  test("rejects a blocked executable extension", () => {
    assert.throws(() =>
      validateUpload({ fileName: "installer.exe", mimeType: "application/octet-stream", size: 100 })
    );
  });

  test("rejects a blocked extension case-insensitively", () => {
    assert.throws(() => validateUpload({ fileName: "script.SH", mimeType: "text/plain", size: 100 }));
  });
});

describe("src/lib/attachments.js#keyFor", () => {
  test("produces different keys for the same file name", () => {
    const a = keyFor(1, "photo.jpg");
    const b = keyFor(1, "photo.jpg");
    assert.notEqual(a, b);
  });

  test("scopes the key under the conversation id", () => {
    const key = keyFor(42, "photo.jpg");
    assert.match(key, /^conversations\/42\//);
  });

  test("strips characters that aren't safe in an object key", () => {
    const key = keyFor(1, "my photo (final)!.jpg");
    assert.doesNotMatch(key, /[ ()!]/);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { validateJobId, validateJobInput } from "../lib/validation.mjs";

test("validateJobInput applies safe defaults and normalizes the URL", () => {
  assert.deepEqual(validateJobInput({ url: "https://example.com/path" }), {
    url: "https://example.com/path",
    options: { dark: true, screenshots: true, depth: 1, wait: 1500 },
  });
});

test("validateJobInput accepts bounded extraction options", () => {
  const value = validateJobInput({
    url: "http://127.0.0.1:4220/",
    options: { dark: false, screenshots: false, depth: 0, wait: 30000 },
  });
  assert.equal(value.options.depth, 0);
  assert.equal(value.options.wait, 30000);
});

for (const [name, body, field] of [
  ["non-http scheme", { url: "file:///etc/passwd" }, "url"],
  ["credentials", { url: "https://user:secret@example.com" }, "url"],
  ["depth above limit", { url: "https://example.com", options: { depth: 6 } }, "options.depth"],
  ["negative wait", { url: "https://example.com", options: { wait: -1 } }, "options.wait"],
  ["string boolean", { url: "https://example.com", options: { dark: "true" } }, "options.dark"],
]) {
  test(`validateJobInput rejects ${name}`, () => {
    assert.throws(
      () => validateJobInput(body),
      (error) => error.code === "VALIDATION_ERROR" && error.field === field,
    );
  });
}

test("validateJobId rejects path-like identifiers", () => {
  assert.throws(() => validateJobId("../job.json"), /Invalid job id/);
  assert.equal(validateJobId("mabc1234-123456789abc"), "mabc1234-123456789abc");
});

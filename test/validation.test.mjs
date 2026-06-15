import assert from "node:assert/strict";
import test from "node:test";
import {
  validateAnalyzeInput,
  validateApplicationId,
  validateApplicationInput,
  validateJobId,
  validateJobInput,
} from "../lib/validation.mjs";

test("validateJobInput applies safe defaults and normalizes the URL", () => {
  assert.deepEqual(validateJobInput({ url: "https://example.com/path" }), {
    url: "https://example.com/path",
    options: { dark: true, screenshots: true, depth: 1, wait: 1500, layout: false },
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

test("validateJobInput controls the layout option (opt-in: default false)", () => {
  assert.equal(validateJobInput({ url: "https://example.com" }).options.layout, false);
  assert.equal(
    validateJobInput({ url: "https://example.com", options: { layout: true } }).options.layout,
    true,
  );
  assert.equal(
    validateJobInput({ url: "https://example.com", options: { layout: false } }).options.layout,
    false,
  );
  assert.throws(
    () => validateJobInput({ url: "https://example.com", options: { layout: "no" } }),
    (error) => error.code === "VALIDATION_ERROR" && error.field === "options.layout",
  );
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

test("application validation requires an absolute-path-shaped value, mode, and confirmation", () => {
  assert.deepEqual(
    validateAnalyzeInput({ targetPath: "/tmp/project" }),
    { targetPath: "/tmp/project" },
  );
  assert.deepEqual(
    validateApplicationInput({
      targetPath: "/tmp/project",
      mode: "safe",
      confirmed: true,
    }),
    { targetPath: "/tmp/project", mode: "safe", confirmed: true },
  );
  assert.throws(
    () => validateApplicationInput({
      targetPath: "/tmp/project",
      mode: "safe",
      confirmed: false,
    }),
    (error) => error.field === "confirmed",
  );
  assert.throws(
    () => validateApplicationInput({
      targetPath: "/tmp/project",
      mode: "unsafe",
      confirmed: true,
    }),
    (error) => error.field === "mode",
  );
  assert.equal(
    validateApplicationId("aabc1234-123456789abc"),
    "aabc1234-123456789abc",
  );
});

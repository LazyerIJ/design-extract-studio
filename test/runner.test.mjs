import assert from "node:assert/strict";
import test from "node:test";
import { buildDesignlangArgs } from "../lib/runner.mjs";

test("designlang arguments keep the URL and options as discrete values", () => {
  const url = "https://example.com/path;echo-not-a-shell-command";
  const args = buildDesignlangArgs({
    url,
    options: { dark: true, screenshots: false, depth: 2, wait: 2500 },
  }, "/tmp/job artifacts");

  assert.deepEqual(args.slice(0, 3), ["--yes", "designlang", url]);
  assert.equal(args[args.indexOf("--out") + 1], "/tmp/job artifacts");
  assert.equal(args[args.indexOf("--depth") + 1], "2");
  assert.equal(args[args.indexOf("--wait") + 1], "2500");
  assert.equal(args.includes("--dark"), true);
  assert.equal(args.includes("--screenshots"), false);
  assert.equal(args.includes("--system-chrome"), true);
  assert.equal(args.includes("--quiet"), true);
  assert.equal(args.includes("--no-history"), true);
});

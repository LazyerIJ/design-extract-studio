import assert from "node:assert/strict";
import test from "node:test";
import {
  createTargetProcessEnv,
  runProcess,
} from "../lib/process-utils.mjs";

test("target process environment keeps runtime basics and drops sensitive server variables", async () => {
  const original = {
    CODEX_HOME: process.env.CODEX_HOME,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    NPM_TOKEN: process.env.NPM_TOKEN,
  };
  process.env.CODEX_HOME = "/tmp/custom-codex-home";
  process.env.OPENAI_API_KEY = "openai-secret";
  process.env.GITHUB_TOKEN = "github-secret";
  process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
  process.env.NPM_TOKEN = "npm-secret";
  try {
    const env = createTargetProcessEnv({ CI: "1", NO_COLOR: "1" });
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.CODEX_HOME, "/tmp/custom-codex-home");
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.CI, "1");
    assert.equal("OPENAI_API_KEY" in env, false);
    assert.equal("GITHUB_TOKEN" in env, false);
    assert.equal("AWS_SECRET_ACCESS_KEY" in env, false);
    assert.equal("NPM_TOKEN" in env, false);

    const result = await runProcess(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify(process.env))",
      ],
      { inheritEnv: false, env },
    );
    const childEnv = JSON.parse(result.stdout);
    assert.equal(childEnv.HOME, process.env.HOME);
    assert.equal(childEnv.CODEX_HOME, "/tmp/custom-codex-home");
    assert.equal(childEnv.CI, "1");
    assert.equal("OPENAI_API_KEY" in childEnv, false);
    assert.equal("GITHUB_TOKEN" in childEnv, false);
    assert.equal("AWS_SECRET_ACCESS_KEY" in childEnv, false);
    assert.equal("NPM_TOKEN" in childEnv, false);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

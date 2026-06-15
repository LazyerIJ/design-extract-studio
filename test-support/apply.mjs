import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../lib/process-utils.mjs";

async function git(root, args) {
  const result = await runProcess("git", args, { cwd: root, timeoutMs: 10000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

export async function createWebProject(root, options = {}) {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "apply-fixture",
      private: true,
      scripts: options.scripts ?? {},
      dependencies: {
        vite: "^6.0.0",
        react: "^19.0.0",
        ...(options.tailwind ? { tailwindcss: options.tailwind } : {}),
      },
    }, null, 2)}\n`,
  );
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(join(root, "src", "main.jsx"), 'import "./index.css";\n');
  await writeFile(join(root, "src", "index.css"), ":root { color: white; }\n");
  if (options.shadcn) {
    await writeFile(join(root, "components.json"), '{"style":"new-york"}\n');
  }
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "fixture@example.test"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "fixture"]);
  return root;
}

export async function commitAll(root, message = "fixture update") {
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", message]);
}

export async function createArtifactFixture(root) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "fixture-variables.css"),
    ":root { --color-primary: #ef4444; --radius-card: 14px; }\n",
  );
  await writeFile(join(root, "fixture-reset.css"), "*,*::before,*::after{box-sizing:border-box}\n");
  await writeFile(
    join(root, "fixture-motion.css"),
    ":root { --duration-fast: 120ms; --ease-out: ease-out; }\n",
  );
  await writeFile(
    join(root, "fixture-design-tokens.json"),
    '{"color":{"primary":{"$value":"#ef4444"}}}\n',
  );
  await writeFile(
    join(root, "fixture-design-language.md"),
    "# Fixture design language\n\n**Overall: 88/100 (Grade: B)**\n",
  );
  return root;
}


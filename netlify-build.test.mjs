import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL(".", import.meta.url));

test("builds a standalone Netlify preview with in-app authentication and generation disabled", async () => {
  const build = spawnSync(process.execPath, ["build-netlify.mjs"], {
    cwd: projectDirectory,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const outputDirectory = new URL("./dist/", import.meta.url);
  const files = await readdir(outputDirectory);
  assert.deepEqual(files, ["index.html"]);

  const html = await readFile(new URL("index.html", outputDirectory), "utf8");
  assert.match(html, /const isStaticDemo = true;/);
  assert.match(html, /Static preview only\./);
  assert.doesNotMatch(html, /REPLICATE_API_TOKEN|Hugging Face|Open the free video demo/);
});

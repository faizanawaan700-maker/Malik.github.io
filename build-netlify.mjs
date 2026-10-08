import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(projectDirectory, "index.html"), "utf8");
const previewGuard = 'const isStaticDemo = window.location.hostname.endsWith(".github.io") || window.location.hostname.endsWith(".netlify.app");';

if (!source.includes(previewGuard)) {
  throw new Error("The static preview guard was not found in index.html.");
}

const staticPreview = source.replace(previewGuard, "const isStaticDemo = true;");
const outputDirectory = join(projectDirectory, "dist");
await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, "index.html"), staticPreview);
console.log("Built the static Netlify preview in dist/.");

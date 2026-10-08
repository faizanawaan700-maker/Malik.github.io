import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const source = (await readFile(join(projectDirectory, "index.html"), "utf8")).replace(/\r\n/g, "\n");
const previewGuard = `const isStaticDemo = window.location.protocol === "file:" ||
          !isLocalPrivateHost(hostname) &&
          (hostname.endsWith(".github.io") || hostname.endsWith(".netlify.app"));`;

if (!source.includes(previewGuard)) {
  throw new Error("The static preview guard was not found in index.html.");
}

const staticPreview = source.replace(previewGuard, "const isStaticDemo = true;");
const outputDirectory = join(projectDirectory, "dist");
await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, "index.html"), staticPreview);
console.log("Built the static Netlify preview in dist/.");

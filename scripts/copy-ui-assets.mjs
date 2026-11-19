#!/usr/bin/env node
/** Copia los assets estáticos de la UI a dist/ tras compilar con tsc. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "ui", "public");
const destination = path.join(root, "dist", "ui", "public");

await fs.mkdir(destination, { recursive: true });
for (const name of await fs.readdir(source)) {
  await fs.copyFile(path.join(source, name), path.join(destination, name));
}
console.log("Assets de la UI copiados a dist/ui/public");

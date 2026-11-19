import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CleanerRuleSet } from "../src/types/index.js";
import { DEFAULT_RULES } from "../src/rules/defaults.js";

export async function writeFixtureFile(
  root: string,
  relative: string,
  content: string
): Promise<void> {
  const abs = path.join(root, relative);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/** Reglas de test: umbral "grande" diminuto para ejercitar esa rama sin MB reales. */
export function testRules(): CleanerRuleSet {
  return {
    ...DEFAULT_RULES,
    defaults: { ...DEFAULT_RULES.defaults, largeThresholdMB: 0.001 }
  };
}

/**
 * Árbol de prueba:
 * - proj-node: TypeScript + Node.js, con artefactos safe, protegidos y review.
 * - proj-py: Python con __pycache__ y .venv.
 * - grupo/proj-go: Go anidado (descubrimiento en profundidad).
 * - no-proyecto: carpeta sin marcadores, con un archivo "grande".
 */
export async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-test-"));

  await writeFixtureFile(
    root,
    "proj-node/package.json",
    '{"name":"proj-node"}'
  );
  await writeFixtureFile(root, "proj-node/tsconfig.json", "{}");
  await writeFixtureFile(
    root,
    "proj-node/.gitignore",
    "node_modules/\ndist/\n*.log\n"
  );
  await writeFixtureFile(
    root,
    "proj-node/src/index.ts",
    "export const x = 1;\n"
  );
  await writeFixtureFile(
    root,
    "proj-node/node_modules/left-pad/index.js",
    "module.exports = 1;"
  );
  // Marcador dentro de node_modules: NO debe crear un proyecto anidado.
  await writeFixtureFile(
    root,
    "proj-node/node_modules/left-pad/package.json",
    '{"name":"left-pad"}'
  );
  await writeFixtureFile(root, "proj-node/dist/index.js", "compiled();");
  await writeFixtureFile(root, "proj-node/debug.log", "traza");
  await writeFixtureFile(root, "proj-node/.env", "SECRET=1");
  await writeFixtureFile(root, "proj-node/.git/config", "[core]");
  await writeFixtureFile(root, "proj-node/datos.bin", "x".repeat(64));

  await writeFixtureFile(
    root,
    "proj-py/pyproject.toml",
    "[project]\nname='x'\n"
  );
  await writeFixtureFile(root, "proj-py/__pycache__/mod.cpython-312.pyc", "x");
  await writeFixtureFile(root, "proj-py/.venv/pyvenv.cfg", "home = /usr/bin");

  await writeFixtureFile(root, "grupo/proj-go/go.mod", "module ejemplo");
  await writeFixtureFile(root, "grupo/proj-go/main.go", "package main");

  await writeFixtureFile(root, "no-proyecto/notas.txt", "hola");
  await writeFixtureFile(root, "no-proyecto/grande.dat", "x".repeat(4096));

  return root;
}

/** Lista recursiva de archivos (rutas relativas) para verificar solo-lectura. */
export async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(path.join(dir, d.name), childRel);
      else result.push(childRel);
    }
  }
  await walk(root, "");
  return result.sort();
}

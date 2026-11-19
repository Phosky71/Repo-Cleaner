#!/usr/bin/env node
/**
 * Verificación de empaquetado (fase 5, E1).
 * Comprueba build, entrypoint, assets UI, reglas, comando global,
 * servidor UI en localhost y tests. Falla claramente si algo no pasa.
 * No publica nada en npm.
 */
import { spawnSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist", "cli", "index.js");
const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function run(commandLine, options = {}) {
  return spawnSync(commandLine, {
    cwd: root,
    encoding: "utf8",
    shell: true,
    timeout: 600000,
    ...options
  });
}

// 1. Build correcto.
const build = run("npm run build");
record(
  "npm run build",
  build.status === 0,
  build.status === 0 ? "" : (build.stderr || "").slice(0, 200)
);

// 2. Entry point compilado y ejecutable (shebang).
let entryOk;
let entryDetail = "no existe dist/cli/index.js";
try {
  const head = readFileSync(entry, "utf8").slice(0, 40);
  entryOk = head.startsWith("#!");
  entryDetail = entryOk ? "shebang presente" : "falta shebang";
} catch {
  entryOk = false;
}
record("dist/cli/index.js ejecutable", entryOk, entryDetail);

// 3. Assets de la UI en dist/.
const assets = ["index.html", "styles.css", "app.js"];
const missing = [];
for (const asset of assets) {
  const file = path.join(root, "dist", "ui", "public", asset);
  if (!(await fs.stat(file).catch(() => null))) missing.push(asset);
}
record(
  "assets UI en dist/ui/public",
  missing.length === 0,
  missing.length ? `faltan: ${missing.join(", ")}` : assets.join(", ")
);

// 4. Reglas cargables desde el paquete construido.
let rulesOk = false;
let rulesDetail;
try {
  const { loadRules } = await import("../dist/rules/loader.js");
  const { rules } = await loadRules(path.join(root, "config", "rules.json"));
  rulesOk = rules.version === 1 && rules.safe.length > 0;
  rulesDetail = `${rules.safe.length} safe, ${rules.protected.length} protected`;
} catch (error) {
  rulesDetail = error.message;
}
record("config/rules.json cargable (dist)", rulesOk, rulesDetail);

// 5 y 6. Comando global repo-cleaner (con fallback al entrypoint local).
function cliCheck(args, label) {
  const global = run(`repo-cleaner ${args.join(" ")}`);
  if (global.status === 0) {
    record(label, true, "comando global (npm link)");
    return;
  }
  const local = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 600000
  });
  record(
    label,
    local.status === 0,
    local.status === 0
      ? "fallback: node dist/cli/index.js (npm link no disponible)"
      : (local.stderr || "").slice(0, 200)
  );
}
cliCheck(["--help"], "repo-cleaner --help");
cliCheck(
  ["rules", "--config", "config/rules.json"],
  "repo-cleaner rules --config config/rules.json"
);

// 7. Servidor UI en localhost + /api/health.
let uiOk = false;
let uiDetail;
let server;
try {
  const { startServer } = await import("../dist/ui/server.js");
  const { loadRules } = await import("../dist/rules/loader.js");
  const { rules } = await loadRules(path.join(root, "config", "rules.json"));
  const fixture = await fs.mkdtemp(
    path.join(os.tmpdir(), "repo-cleaner-verify-")
  );
  server = startServer({ allowedRoot: fixture, rules }, 0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/api/health`);
  const body = await health.json();
  const home = await fetch(base);
  const html = await home.text();
  uiOk =
    address.address === "127.0.0.1" &&
    health.status === 200 &&
    body.status === "ok" &&
    home.status === 200 &&
    html.includes("Repo Cleaner");
  uiDetail = `127.0.0.1:${address.port}, health ok, UI servida`;
  await fs.rm(fixture, { recursive: true, force: true });
} catch (error) {
  uiDetail = error.message;
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
}
record("servidor UI en localhost + /api/health", uiOk, uiDetail);

// 8. Tests en verde.
const tests = run("npm test");
record(
  "npm test",
  tests.status === 0,
  tests.status === 0 ? "" : "ver salida de vitest"
);

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length > 0) {
  console.error(
    `VERIFICACIÓN FALLIDA: ${failed.length} de ${results.length} comprobaciones.`
  );
  process.exit(1);
}
console.log(
  `VERIFICACIÓN CORRECTA: ${results.length}/${results.length} comprobaciones.`
);

#!/usr/bin/env node
/**
 * Retirada del legacy v0 (Fase 2, decisión autorizada 2).
 *
 * 1. Copia los archivos legacy a legacy/v0-backup-<timestamp>/src/.
 * 2. Calcula SHA-256 de original y copia, y verifica que coinciden.
 * 3. Escribe manifest.json con las huellas (evidencia auditable).
 * 4. Solo con --remove: elimina los originales TRAS verificar el backup.
 *
 * Uso:
 *   node scripts/retire-legacy.mjs           # solo backup + verificación
 *   node scripts/retire-legacy.mjs --remove  # backup + retirada de originales
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const LEGACY_FILES = [
  "src/index.ts",
  "src/scanner.ts",
  "src/rules.ts",
  "src/cleaner.ts",
  "src/report.ts",
  "src/config.ts",
  "src/utils.ts"
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

const remove = process.argv.includes("--remove");
const createdAt = new Date();
const backupDir = path.join(
  repoRoot,
  "legacy",
  `v0-backup-${stamp(createdAt)}`
);

if (await fs.stat(backupDir).catch(() => null)) {
  console.error(`El backup ya existe: ${backupDir}. No se sobrescribe.`);
  process.exit(1);
}

const entries = [];
for (const rel of LEGACY_FILES) {
  const original = path.join(repoRoot, rel);
  const content = await fs.readFile(original).catch(() => null);
  if (content === null) {
    console.error(`Falta el archivo legacy: ${rel}. Abortando sin cambios.`);
    process.exit(1);
  }
  const backupRel = path.join("src", path.basename(rel));
  const backupPath = path.join(backupDir, backupRel);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.writeFile(backupPath, content);

  const originalHash = sha256(content);
  const copiedHash = sha256(await fs.readFile(backupPath));
  if (originalHash !== copiedHash) {
    console.error(`Hash mismatch en ${rel}. Abortando sin eliminar nada.`);
    process.exit(1);
  }
  entries.push({
    originalPath: rel,
    backupPath: backupRel.replace(/\\/g, "/"),
    sha256: originalHash,
    sizeBytes: content.length
  });
  console.log(
    `Backup verificado: ${rel} -> ${backupRel} (${originalHash.slice(0, 12)}…)`
  );
}

const manifest = {
  createdAt: createdAt.toISOString(),
  reason: "Retirada del legacy v0 — Fase 2 de docs/PLAN.md (autorizado)",
  files: entries
};
await fs.writeFile(
  path.join(backupDir, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8"
);
console.log(`Manifest: ${path.join(backupDir, "manifest.json")}`);

if (remove) {
  for (const rel of LEGACY_FILES) {
    await fs.unlink(path.join(repoRoot, rel));
    console.log(`Retirado: ${rel}`);
  }
  console.log("Legacy v0 retirado. Backup completo y verificado en legacy/.");
} else {
  console.log("Backup completo. Usa --remove para retirar los originales.");
}

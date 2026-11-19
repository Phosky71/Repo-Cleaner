import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Base escribible para las salidas por defecto (reports/ y logs/).
 * Usa el directorio de trabajo actual si es escribible; si no (p. ej.
 * C:\Windows\System32 sin privilegios), cae a ~/.repo-cleaner.
 *
 * La comprobación es una sonda de escritura REAL (crear y borrar un
 * directorio temporal): en Windows, accessSync(W_OK) no refleja las ACLs
 * y da falsos positivos en directorios del sistema.
 *
 * Las rutas explícitas (--reports-dir, --audit-path, opciones del servidor)
 * siempre se respetan y se resuelven contra el cwd.
 */
export function writableOutputBase(): string {
  const cwd = process.cwd();
  try {
    const probe = fs.mkdtempSync(path.join(cwd, ".repo-cleaner-write-test-"));
    fs.rmSync(probe, { recursive: true, force: true });
    return cwd;
  } catch {
    return path.join(os.homedir(), ".repo-cleaner");
  }
}

export function resolveReportsDir(explicit?: string): string {
  if (explicit !== undefined && explicit !== "") {
    return path.resolve(explicit);
  }
  return path.join(writableOutputBase(), "reports");
}

export function resolveAuditPath(explicit?: string): string {
  if (explicit !== undefined && explicit !== "") {
    return path.resolve(explicit);
  }
  return path.join(writableOutputBase(), "logs", "clean-audit.jsonl");
}

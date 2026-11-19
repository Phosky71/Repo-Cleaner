import { promises as fs } from "node:fs";
import path from "node:path";
import type { AuditRecord } from "../types/index.js";
import { resolveAuditPath } from "./output-paths.js";

/**
 * Registra una acción de limpieza en el log de auditoría (JSONL).
 * Solo metadatos: nunca contenido de ficheros ni secretos.
 * Ruta por defecto: cwd escribible o ~/.repo-cleaner (ver output-paths).
 */
export async function appendAudit(
  record: AuditRecord,
  auditPath?: string
): Promise<string> {
  const resolved = resolveAuditPath(auditPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.appendFile(resolved, JSON.stringify(record) + "\n", "utf8");
  return resolved;
}

/** Lee el log de auditoría (para informes y tests). */
export async function readAudit(auditPath?: string): Promise<AuditRecord[]> {
  const resolved = resolveAuditPath(auditPath);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

import { promises as fs } from "node:fs";
import path from "node:path";
import type { AuditRecord } from "../types/index.js";

export const DEFAULT_AUDIT_PATH = path.join("logs", "clean-audit.jsonl");

/**
 * Registra una acción de limpieza en el log de auditoría (JSONL).
 * Solo metadatos: nunca contenido de ficheros ni secretos.
 */
export async function appendAudit(
  record: AuditRecord,
  auditPath: string = DEFAULT_AUDIT_PATH
): Promise<string> {
  const resolved = path.resolve(auditPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.appendFile(resolved, JSON.stringify(record) + "\n", "utf8");
  return resolved;
}

/** Lee el log de auditoría (para informes y tests). */
export async function readAudit(
  auditPath: string = DEFAULT_AUDIT_PATH
): Promise<AuditRecord[]> {
  const resolved = path.resolve(auditPath);
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

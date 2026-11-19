import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type {
  AuditRecord,
  ReportPaths,
  TrashAdminOptions,
  TrashPurgeItem,
  TrashPurgeReport,
  TrashSessionInfo
} from "../types/index.js";
import { appendAudit } from "./audit.js";
import { resolveAuditPath } from "./output-paths.js";
import { TRASH_DIR_NAME } from "./trash.js";
import {
  listTrashSessions,
  readTrashSession,
  sessionItemStates
} from "./restore.js";
import {
  printTrashPurgeSummary,
  printTrashSessionDetail,
  printTrashSessions,
  saveTrashPurgeReport
} from "./report.js";
import { formatBytes } from "./format.js";

const SESSION_ID_PATTERN = /^\d{8}-\d{6}(-\d+)?$/;

export interface SessionEligibility {
  removable: boolean;
  reason: string;
}

/**
 * Una sesión solo es eliminable si NO queda ningún elemento pendiente de
 * restaurar (restaurados, idénticos omitidos, fallidos irreversibles o
 * almacén ausente). Nunca se elimina automáticamente.
 */
export function assessSessionEligibility(
  info: TrashSessionInfo
): SessionEligibility {
  if (info.restorableCount > 0) {
    return {
      removable: false,
      reason: `${info.restorableCount} elementos pendientes de restaurar`
    };
  }
  if (info.pendingCount === 0) {
    return { removable: true, reason: "todos los elementos restaurados" };
  }
  return {
    removable: true,
    reason: "sin elementos restaurables (almacén ausente o no restaurable)"
  };
}

/**
 * Elimina una sesión de papelera elegible, con auditoría `action: "purge"`.
 * Revalida pertenencia al target, formato de sessionId y symlinks.
 * El log de auditoría se conserva aunque la sesión desaparezca.
 */
export async function purgeTrashSession(
  target: string,
  sessionId: string,
  options: { auditPath?: string } = {}
): Promise<TrashPurgeItem> {
  const absTarget = path.resolve(target);
  const auditPath = resolveAuditPath(options.auditPath);
  const base: AuditRecord = {
    timestamp: new Date().toISOString(),
    target: absTarget,
    relativePath: `${TRASH_DIR_NAME}/${sessionId}`,
    risk: "safe",
    action: "purge",
    sizeBytes: 0,
    approvedBy: "human",
    sessionId,
    result: "skipped"
  };

  const sessions = await listTrashSessions(absTarget);
  const info = sessions.find((s) => s.sessionId === sessionId);
  if (!SESSION_ID_PATTERN.test(sessionId) || !info) {
    const error = "sesión inexistente o inválida para este proyecto";
    await appendAudit({ ...base, error }, auditPath);
    return { sessionId, result: "skipped", sizeBytes: 0, error };
  }
  base.sizeBytes = info.totalBytes;
  base.planId = info.planId;

  const eligibility = assessSessionEligibility(info);
  if (!eligibility.removable) {
    await appendAudit({ ...base, error: eligibility.reason }, auditPath);
    return {
      sessionId,
      result: "skipped",
      sizeBytes: info.totalBytes,
      error: eligibility.reason
    };
  }

  try {
    const trashRoot = path.join(absTarget, TRASH_DIR_NAME);
    if (path.dirname(info.sessionDir) !== trashRoot) {
      throw new Error("la sesión no pertenece al target autorizado");
    }
    const stat = await fs.lstat(info.sessionDir);
    if (stat.isSymbolicLink()) {
      throw new Error("la sesión es un symlink: no se elimina");
    }
    await fs.rm(info.sessionDir, {
      recursive: true,
      force: false,
      maxRetries: 3,
      retryDelay: 200
    });
    await appendAudit({ ...base, result: "purged" }, auditPath);
    return { sessionId, result: "purged", sizeBytes: info.totalBytes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendAudit({ ...base, result: "failed", error: message }, auditPath);
    return {
      sessionId,
      result: "failed",
      sizeBytes: info.totalBytes,
      error: message
    };
  }
}

async function defaultAsk(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export interface TrashAdminOutcome {
  sessions: TrashSessionInfo[];
  report?: TrashPurgeReport;
  paths?: ReportPaths;
}

/**
 * Orquestador de `trash`: listar -> inspeccionar (--session) -> purga
 * selectiva (--remove / --remove-completed) con confirmación humana,
 * auditoría por sesión e informe final.
 */
export async function trashRepository(
  target: string,
  options: TrashAdminOptions = {}
): Promise<TrashAdminOutcome> {
  const absTarget = path.resolve(target);
  const stat = await fs.lstat(absTarget).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`La ruta no existe o no es un directorio: ${absTarget}`);
  }

  const sessions = await listTrashSessions(absTarget);
  printTrashSessions(sessions);

  if (options.session) {
    const session = await readTrashSession(absTarget, options.session);
    const states = await sessionItemStates(session);
    printTrashSessionDetail(session, states);
  }

  let targets: string[];
  if (options.remove) {
    if (!options.session) {
      throw new Error("--remove requiere --session <timestamp>");
    }
    targets = [options.session];
  } else if (options.removeCompleted) {
    targets = sessions
      .filter((s) => assessSessionEligibility(s).removable)
      .map((s) => s.sessionId);
  } else {
    return { sessions };
  }

  if (targets.length === 0) {
    console.log("\nNo hay sesiones elegibles para eliminar.");
    return { sessions };
  }

  const eligibleInfos = sessions.filter((s) => targets.includes(s.sessionId));
  const totalBytes = eligibleInfos.reduce((acc, s) => acc + s.totalBytes, 0);

  if (options.dryRun) {
    console.log(
      `\nDry-run: se eliminarían ${targets.length} sesiones (${formatBytes(totalBytes)}): ${targets.join(", ")}. No se ha tocado nada.`
    );
    return { sessions };
  }

  const interactive = options.isInteractive ?? process.stdin.isTTY === true;
  const ask = options.ask ?? defaultAsk;
  if (!options.yes) {
    if (!interactive) {
      throw new Error(
        "Sin terminal interactivo y sin --yes: no se puede confirmar la eliminación de sesiones."
      );
    }
    const confirmation = await ask(
      `\n¿Eliminar ${targets.length} sesiones de papelera (${formatBytes(totalBytes)}) de forma permanente? Escribe "yes" o "sí": `
    );
    if (!/^(yes|sí|si)$/i.test(confirmation.trim())) {
      console.log("Operación cancelada: no se ha eliminado ninguna sesión.");
      return { sessions };
    }
  } else {
    console.log(
      `\n--yes activo: eliminación consciente de ${targets.length} sesiones.`
    );
  }

  const purged: TrashPurgeItem[] = [];
  for (const sessionId of targets) {
    purged.push(
      await purgeTrashSession(absTarget, sessionId, {
        auditPath: options.auditPath
      })
    );
  }

  const purgedIds = new Set(
    purged.filter((p) => p.result === "purged").map((p) => p.sessionId)
  );
  const report: TrashPurgeReport = {
    id: randomUUID(),
    target: absTarget,
    generatedAt: new Date().toISOString(),
    sessions,
    eligible: targets,
    purged,
    kept: sessions
      .filter((s) => !purgedIds.has(s.sessionId))
      .map((s) => s.sessionId),
    freedBytes: purged
      .filter((p) => p.result === "purged")
      .reduce((acc, p) => acc + p.sizeBytes, 0),
    errors: purged
      .filter((p) => p.result !== "purged" && p.error)
      .map((p) => `${p.sessionId}: ${p.error}`)
  };
  const paths = await saveTrashPurgeReport(report, options.reportsDir);
  printTrashPurgeSummary(report, paths);
  return { sessions, report, paths };
}

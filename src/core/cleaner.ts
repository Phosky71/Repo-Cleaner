import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type {
  AuditRecord,
  CleanAction,
  CleanerRuleSet,
  CleanOptions,
  CleanPlan,
  CleanPlanItem,
  CleanResult,
  CleanResultItem,
  CleanSelection,
  ReportPaths,
  ScanEntry,
  ScanReport
} from "../types/index.js";
import { scanProject } from "./scanner.js";
import { assertSafeToDelete } from "./safety.js";
import { appendAudit } from "./audit.js";
import { resolveAuditPath } from "./output-paths.js";
import {
  createTrashSession,
  planHashOf,
  trashItem,
  TRASH_DIR_NAME
} from "./trash.js";
import { verifyGitStatus } from "./git.js";
import {
  printCleanPlan,
  printCleanResult,
  printProjectAnalysis,
  saveCleanResult
} from "./report.js";
import { formatBytes } from "./format.js";

function normalizeSelector(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

/**
 * Crea el plan de limpieza (puro, sin efectos):
 * - Por defecto solo elementos `safe`; `review` únicamente con selección
 *   explícita (`includeReview` o `only`).
 * - `protected` nunca puede seleccionarse.
 * - Deduplica anidados: si un directorio y su descendiente están
 *   seleccionados, gana el directorio (evita movimientos imposibles).
 */
export function createCleanPlan(
  report: ScanReport,
  selection: CleanSelection = {},
  action: CleanAction = "trash"
): CleanPlan {
  const byPath = new Map(report.entries.map((e) => [e.relativePath, e]));
  let candidates = report.entries.filter(
    (e) => e.risk === "safe" || (selection.includeReview && e.risk === "review")
  );

  if (selection.only && selection.only.length > 0) {
    const chosen: ScanEntry[] = [];
    for (const raw of selection.only) {
      const rel = normalizeSelector(raw);
      const entry = byPath.get(rel);
      if (!entry) {
        throw new Error(
          `Selección inválida: "${raw}" no aparece en el análisis del proyecto`
        );
      }
      if (entry.risk === "protected") {
        throw new Error(
          `Selección inválida: "${raw}" está protegido y nunca puede eliminarse`
        );
      }
      chosen.push(entry);
    }
    candidates = chosen;
  }

  if (selection.exclude && selection.exclude.length > 0) {
    const excluded = new Set(selection.exclude.map(normalizeSelector));
    candidates = candidates.filter((e) => !excluded.has(e.relativePath));
  }

  const selectedPaths = new Set(candidates.map((e) => e.relativePath));
  const topLevel = candidates.filter((entry) => {
    const segments = entry.relativePath.split("/");
    for (let i = segments.length - 1; i >= 1; i -= 1) {
      if (selectedPaths.has(segments.slice(0, i).join("/"))) return false;
    }
    return true;
  });
  topLevel.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const items: CleanPlanItem[] = topLevel.map((entry) => ({
    entry,
    action,
    approved: true
  }));

  return {
    id: randomUUID(),
    scanReportId: report.id,
    target: report.target,
    projectTypes: report.projectTypes,
    items,
    totalBytes: items.reduce((acc, item) => acc + item.entry.sizeBytes, 0),
    createdAt: new Date().toISOString()
  };
}

export interface ExecuteOptions {
  auditPath?: string;
  trashDir?: string;
}

/**
 * Ejecuta un plan ya aprobado. Para cada elemento:
 * 1. Safety Guard justo antes de actuar (con invariantes internas).
 * 2. Papelera (por defecto) o borrado permanente explícito.
 * 3. Registro de auditoría JSONL de cada acción.
 */
export async function executeCleanPlan(
  plan: CleanPlan,
  rules: CleanerRuleSet,
  options: ExecuteOptions = {}
): Promise<CleanResult> {
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  const action: CleanAction = plan.items[0]?.action ?? "trash";
  const auditPath = resolveAuditPath(options.auditPath);
  const planHash = planHashOf(plan);

  let session;
  if (action === "trash" && plan.items.some((item) => item.approved)) {
    session = await createTrashSession(plan.target, plan, options.trashDir);
  }

  const items: CleanResultItem[] = [];
  let executedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let freedBytes = 0;

  for (const item of plan.items) {
    const entry = item.entry;
    const base: AuditRecord = {
      timestamp: new Date().toISOString(),
      target: plan.target,
      relativePath: entry.relativePath,
      risk: entry.risk,
      action: item.action,
      sizeBytes: entry.sizeBytes,
      approvedBy: "human",
      planId: plan.id,
      result: "skipped"
    };

    if (!item.approved) {
      skippedCount += 1;
      items.push({ entry, action: item.action, result: "skipped" });
      await appendAudit(base, auditPath);
      continue;
    }

    try {
      assertSafeToDelete(
        entry.absolutePath,
        plan.target,
        rules,
        plan.projectTypes,
        // Un review solo llega aquí con selección humana explícita + confirmación.
        { allowReview: entry.risk === "review" }
      );
      const stat = await fs.lstat(entry.absolutePath).catch(() => null);
      if (!stat) {
        skippedCount += 1;
        items.push({
          entry,
          action: item.action,
          result: "skipped",
          error: "ya no existe"
        });
        await appendAudit({ ...base, error: "ya no existe" }, auditPath);
        continue;
      }
      if (stat.isSymbolicLink()) {
        throw new Error("es un enlace simbólico: no se elimina ni se mueve");
      }

      if (item.action === "trash") {
        if (!session) {
          throw new Error("sesión de papelera no inicializada");
        }
        const meta = await trashItem(session, entry, planHash);
        executedCount += 1;
        freedBytes += entry.sizeBytes;
        items.push({
          entry,
          action: item.action,
          result: "trashed",
          storedPath: meta.storedPath
        });
        await appendAudit({ ...base, result: "trashed" }, auditPath);
      } else {
        await fs.rm(entry.absolutePath, {
          recursive: true,
          force: false,
          maxRetries: 3,
          retryDelay: 200
        });
        executedCount += 1;
        freedBytes += entry.sizeBytes;
        items.push({ entry, action: item.action, result: "deleted" });
        await appendAudit({ ...base, result: "deleted" }, auditPath);
      }
    } catch (error) {
      failedCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${entry.relativePath}: ${message}`);
      items.push({
        entry,
        action: item.action,
        result: "failed",
        error: message
      });
      await appendAudit(
        { ...base, result: "failed", error: message },
        auditPath
      );
    }
  }

  return {
    id: randomUUID(),
    planId: plan.id,
    scanReportId: plan.scanReportId,
    target: plan.target,
    projectTypes: plan.projectTypes,
    action,
    dryRun: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    items,
    executedCount,
    failedCount,
    skippedCount,
    freedBytes,
    keptCount: skippedCount,
    ...(session ? { trashSessionDir: session.sessionDir } : {}),
    auditPath,
    warnings
  };
}

async function defaultAsk(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/** Aplica la respuesta de selección interactiva a los items del plan. */
export function applyInteractiveSelection(
  plan: CleanPlan,
  answer: string
): void {
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "") return; // Enter = mantener todos los listados
  if (trimmed === "none" || trimmed === "ninguno") {
    for (const item of plan.items) item.approved = false;
    return;
  }
  if (trimmed === "all" || trimmed === "todos") {
    for (const item of plan.items) item.approved = true;
    return;
  }
  const numbers = trimmed
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => {
      const n = Number(token);
      if (!Number.isInteger(n) || n < 1 || n > plan.items.length) {
        throw new Error(
          `Selección inválida: "${token}" (usa números entre 1 y ${plan.items.length}, "all" o "none")`
        );
      }
      return n - 1;
    });
  const selected = new Set(numbers);
  plan.items.forEach((item, index) => {
    item.approved = selected.has(index);
  });
}

export interface CleanSessionOutcome {
  report: ScanReport;
  plan: CleanPlan;
  result: CleanResult | null;
  paths?: ReportPaths;
}

/**
 * Orquestador completo de `clean`:
 * análisis -> plan -> selección/confirmación humana -> ejecución auditada
 * -> verificación Git -> informe final.
 *
 * Dry-run por defecto en el sentido de que NADA se elimina sin confirmación
 * explícita (o `--yes` consciente). `--dry-run` fuerza solo-plan.
 */
export async function cleanRepository(
  target: string,
  rules: CleanerRuleSet,
  options: CleanOptions = {}
): Promise<CleanSessionOutcome> {
  const report = await scanProject(target, rules);
  printProjectAnalysis(report, false);

  const action: CleanAction = options.permanent ? "permanent" : "trash";
  const plan = createCleanPlan(
    report,
    {
      includeReview: options.includeReview,
      only: options.only,
      exclude: options.exclude
    },
    action
  );
  printCleanPlan(plan, report);

  if (options.dryRun) {
    console.log("\nDry-run: no se ha eliminado ni movido nada.");
    return { report, plan, result: null };
  }

  const approvedItems = plan.items.filter((item) => item.approved);
  if (approvedItems.length === 0) {
    console.log("\nNo hay elementos seleccionados: no se hace nada.");
    return { report, plan, result: null };
  }

  const interactive = options.isInteractive ?? process.stdin.isTTY === true;
  const ask = options.ask ?? defaultAsk;

  if (!options.yes) {
    if (!interactive) {
      throw new Error(
        "Sin terminal interactivo y sin --yes: no se puede confirmar la limpieza. " +
          "Usa --dry-run para ver el plan o --yes para automatización consciente."
      );
    }

    const selectionAnswer = await ask(
      `\nSelección [Enter = todos los listados / números separados por comas / "none"]: `
    );
    applyInteractiveSelection(plan, selectionAnswer);

    const selected = plan.items.filter((item) => item.approved);
    if (selected.length === 0) {
      console.log("Selección vacía: operación cancelada.");
      return { report, plan, result: null };
    }
    const selectedBytes = selected.reduce(
      (acc, item) => acc + item.entry.sizeBytes,
      0
    );
    const actionLabel =
      action === "permanent"
        ? "ELIMINAR PERMANENTEMENTE (sin papelera)"
        : `mover a la papelera local (${TRASH_DIR_NAME}/)`;
    const confirmation = await ask(
      `¿Confirmas ${actionLabel} ${selected.length} elementos (${formatBytes(selectedBytes)})? Escribe "yes" o "sí": `
    );
    if (!/^(yes|sí|si)$/i.test(confirmation.trim())) {
      console.log("Operación cancelada: no se ha tocado nada.");
      return { report, plan, result: null };
    }
  } else {
    console.log(
      `\n--yes activo: confirmación automática de ${approvedItems.length} elementos (${formatBytes(plan.totalBytes)}).`
    );
  }

  const result = await executeCleanPlan(plan, rules, {
    auditPath: options.auditPath,
    trashDir: options.trashDir
  });

  result.git = verifyGitStatus(result.target);
  if (result.git.available && result.git.deletedTracked.length > 0) {
    result.warnings.push(
      `Git detecta ${result.git.deletedTracked.length} ficheros versionados eliminados: revisa el informe antes de continuar.`
    );
  }

  const paths = await saveCleanResult(result, report, options.reportsDir);
  printCleanResult(result, report, paths);
  return { report, plan, result, paths };
}

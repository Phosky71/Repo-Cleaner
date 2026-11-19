import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type {
  AuditRecord,
  CleanerRuleSet,
  RestoreConflictMode,
  RestoreOptions,
  RestorePlan,
  RestorePlanItem,
  RestoreResult,
  RestoreResultItem,
  RestoreSelection,
  ReportPaths,
  TrashItemMeta,
  TrashSession,
  TrashSessionInfo,
  TrashSessionStatus
} from "../types/index.js";
import { DEFAULT_RULES } from "../rules/defaults.js";
import { classifyPath } from "./rule-engine.js";
import { appendAudit, DEFAULT_AUDIT_PATH } from "./audit.js";
import { TRASH_DIR_NAME } from "./trash.js";
import {
  printRestorePlan,
  printRestoreResult,
  printRestoreSessions,
  saveRestoreResult
} from "./report.js";
import { formatBytes } from "./format.js";

const SESSION_ID_PATTERN = /^\d{8}-\d{6}(-\d+)?$/;

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function normalizeSelector(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

async function readManifest(sessionDir: string): Promise<TrashSession> {
  const raw = await fs.readFile(path.join(sessionDir, "manifest.json"), "utf8");
  return JSON.parse(raw) as TrashSession;
}

async function writeManifest(session: TrashSession): Promise<void> {
  await fs.writeFile(
    path.join(session.sessionDir, "manifest.json"),
    JSON.stringify(session, null, 2) + "\n",
    "utf8"
  );
}

async function lstatOrNull(abs: string) {
  return fs.lstat(abs).catch(() => null);
}

/**
 * Valida los metadatos de un elemento de papelera contra el target:
 * dentro del objetivo, sin "..", coherente y nunca protegido (reglas
 * vigentes + invariantes internas). Lanza si no es restaurable con seguridad.
 */
export function validateRestoreMeta(
  meta: TrashItemMeta,
  target: string,
  sessionDir: string,
  rules: CleanerRuleSet
): string {
  if (
    meta.relativePath.split(/[\\/]/).includes("..") ||
    meta.originalPath.split(/[\\/]/).includes("..") ||
    meta.storedPath.split(/[\\/]/).includes("..")
  ) {
    throw new Error(
      `Restauración bloqueada: metadatos con ".." (${meta.relativePath})`
    );
  }
  const relative = path.relative(target, meta.originalPath);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Restauración bloqueada: ruta original fuera del objetivo (${meta.originalPath})`
    );
  }
  const computed = relative.replace(/\\/g, "/");
  if (computed !== normalizeSelector(meta.relativePath)) {
    throw new Error(
      `Restauración bloqueada: relativePath incoherente con originalPath (${meta.relativePath})`
    );
  }
  if (classifyPath(computed, rules).risk === "protected") {
    throw new Error(`Restauración bloqueada: ruta protegida (${computed})`);
  }
  if (classifyPath(computed, DEFAULT_RULES).risk === "protected") {
    throw new Error(
      `Restauración bloqueada (invariante): ruta protegida (${computed})`
    );
  }
  const storedAbs = path.resolve(sessionDir, meta.storedPath);
  if (!storedAbs.startsWith(sessionDir + path.sep)) {
    throw new Error(
      `Restauración bloqueada: storedPath fuera de la sesión (${meta.storedPath})`
    );
  }
  return computed;
}

/** Lista las sesiones de papelera válidas del proyecto, con estado. */
export async function listTrashSessions(
  target: string
): Promise<TrashSessionInfo[]> {
  const absTarget = path.resolve(target);
  const trashRoot = path.join(absTarget, TRASH_DIR_NAME);
  const dirents = await fs
    .readdir(trashRoot, { withFileTypes: true })
    .catch(() => []);
  const sessions: TrashSessionInfo[] = [];

  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
    if (!SESSION_ID_PATTERN.test(dirent.name)) continue;
    const sessionDir = path.join(trashRoot, dirent.name);
    let manifest: TrashSession;
    try {
      manifest = await readManifest(sessionDir);
    } catch {
      continue; // sesión corrupta o sin manifest: se ignora
    }
    if (path.resolve(manifest.target) !== absTarget) continue;

    let restorableCount = 0;
    let pendingCount = 0;
    let totalBytes = 0;
    for (const item of manifest.items) {
      totalBytes += item.sizeBytes;
      if (item.restored) continue;
      pendingCount += 1;
      const stored = await lstatOrNull(
        path.resolve(sessionDir, item.storedPath)
      );
      if (stored && !stored.isSymbolicLink()) restorableCount += 1;
    }
    const restoredCount = manifest.items.length - pendingCount;
    const status: TrashSessionStatus =
      pendingCount === 0
        ? manifest.items.length > 0
          ? "restored"
          : "unrestorable"
        : restorableCount === 0
          ? "unrestorable"
          : restorableCount < pendingCount || restoredCount > 0
            ? "partial"
            : "restorable";
    sessions.push({
      sessionId: dirent.name,
      sessionDir,
      createdAt: manifest.createdAt,
      planId: manifest.planId,
      planHash: manifest.planHash,
      itemCount: manifest.items.length,
      pendingCount,
      restoredCount,
      restorableCount,
      totalBytes,
      status
    });
  }
  sessions.sort((a, b) => b.sessionId.localeCompare(a.sessionId));
  return sessions;
}

/** Lee y valida una sesión concreta (sessionId con formato cerrado). */
export async function readTrashSession(
  target: string,
  sessionId: string
): Promise<TrashSession> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`sessionId inválido: ${sessionId}`);
  }
  const absTarget = path.resolve(target);
  const sessionDir = path.join(absTarget, TRASH_DIR_NAME, sessionId);
  const manifest = await readManifest(sessionDir).catch(() => null);
  if (!manifest) {
    throw new Error(`La sesión no existe o no tiene manifest: ${sessionId}`);
  }
  if (path.resolve(manifest.target) !== absTarget) {
    throw new Error(`La sesión ${sessionId} pertenece a otro proyecto`);
  }
  // Normaliza rutas de la sesión a partir del target real (anti-manipulación).
  return {
    ...manifest,
    target: absTarget,
    sessionDir,
    itemsDir: path.join(sessionDir, "items")
  };
}

export interface RestoreItemState {
  meta: TrashItemMeta;
  storedExists: boolean;
  originalExists: boolean;
  conflict: boolean;
}

/** Estado real de cada elemento de la sesión (para UI e informes). */
export async function sessionItemStates(
  session: TrashSession
): Promise<RestoreItemState[]> {
  const states: RestoreItemState[] = [];
  for (const meta of session.items) {
    const stored = await lstatOrNull(
      path.resolve(session.sessionDir, meta.storedPath)
    );
    const original = await lstatOrNull(meta.originalPath);
    states.push({
      meta,
      storedExists: stored !== null && !stored.isSymbolicLink(),
      originalExists: original !== null,
      conflict: original !== null
    });
  }
  return states;
}

export interface RestorePlanOptions {
  onConflict?: RestoreConflictMode;
  overwriteApproved?: boolean;
}

/**
 * Crea el plan de restauración (sin efectos). Valida cada elemento contra
 * el target y las protecciones; detecta conflictos (ruta original existente).
 */
export async function createRestorePlan(
  target: string,
  session: TrashSession,
  selection: RestoreSelection = {},
  options: RestorePlanOptions = {}
): Promise<RestorePlan> {
  const absTarget = path.resolve(target);
  const rules = DEFAULT_RULES;
  let candidates = session.items.filter((item) => !item.restored);

  if (selection.only && selection.only.length > 0) {
    const wanted = new Set(selection.only.map(normalizeSelector));
    const unknown = [...wanted].filter(
      (rel) =>
        !session.items.some(
          (item) => normalizeSelector(item.relativePath) === rel
        )
    );
    if (unknown.length > 0) {
      throw new Error(`Rutas no presentes en la sesión: ${unknown.join(", ")}`);
    }
    candidates = candidates.filter((item) =>
      wanted.has(normalizeSelector(item.relativePath))
    );
  }
  if (candidates.length === 0) {
    throw new Error("No hay elementos pendientes de restaurar en la sesión");
  }

  const items: RestorePlanItem[] = [];
  for (const meta of candidates) {
    validateRestoreMeta(meta, absTarget, session.sessionDir, rules);
    const stored = await lstatOrNull(
      path.resolve(session.sessionDir, meta.storedPath)
    );
    const original = await lstatOrNull(meta.originalPath);
    const conflict = original !== null;
    items.push({
      meta,
      storedExists: stored !== null && !stored.isSymbolicLink(),
      originalExists: conflict,
      conflict,
      resolution: conflict ? (options.onConflict ?? "cancel") : "cancel",
      approved: true
    });
  }

  return {
    id: randomUUID(),
    target: absTarget,
    sessionId: path.basename(session.sessionDir),
    sessionDir: session.sessionDir,
    originalPlanId: session.planId,
    items,
    totalBytes: items.reduce((acc, item) => acc + item.meta.sizeBytes, 0),
    createdAt: new Date().toISOString(),
    overwriteApproved: options.overwriteApproved === true
  };
}

/** Huella SHA-256 del plan de restauración. */
export function restorePlanHashOf(plan: RestorePlan): string {
  const canonical = JSON.stringify({
    id: plan.id,
    target: plan.target,
    sessionId: plan.sessionId,
    originalPlanId: plan.originalPlanId,
    createdAt: plan.createdAt,
    overwriteApproved: plan.overwriteApproved,
    items: plan.items.map((item) => ({
      relativePath: item.meta.relativePath,
      resolution: item.resolution,
      approved: item.approved
    }))
  });
  return createHash("sha256").update(canonical).digest("hex");
}

async function fileHash(abs: string): Promise<string> {
  const content = await fs.readFile(abs);
  return createHash("sha256").update(content).digest("hex");
}

async function identicalFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([lstatOrNull(a), lstatOrNull(b)]);
  if (!sa || !sb || !sa.isFile() || !sb.isFile() || sa.size !== sb.size) {
    return false;
  }
  try {
    return (await fileHash(a)) === (await fileHash(b));
  } catch {
    return false;
  }
}

/** Nunca atravesar symlinks/junctions en los ancestros del destino. */
async function assertNoSymlinkAncestors(
  abs: string,
  target: string
): Promise<void> {
  let current = path.dirname(abs);
  while (current.startsWith(target) && current !== target) {
    const stat = await lstatOrNull(current);
    if (stat?.isSymbolicLink()) {
      throw new Error(`Destino con ancestro symlink: ${current}`);
    }
    if (!stat) break; // se creará con mkdir
    current = path.dirname(current);
  }
}

async function uniqueSuffixPath(originalAbs: string): Promise<string> {
  const base = `${originalAbs}.restored-${stamp(new Date())}`;
  let candidate = base;
  let suffix = 2;
  while (await lstatOrNull(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function moveStoredTo(
  storedAbs: string,
  destination: string
): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(storedAbs, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EXDEV") {
      await fs.cp(storedAbs, destination, { recursive: true });
      await fs.rm(storedAbs, {
        recursive: true,
        force: false,
        maxRetries: 3,
        retryDelay: 200
      });
    } else {
      throw error;
    }
  }
}

/**
 * Ejecuta un plan de restauración aprobado. Por elemento:
 * revalidación de seguridad, resolución de conflictos según lo aprobado,
 * movimiento del almacén a la ruta original, actualización del manifest
 * y auditoría. Nunca sobrescribe sin aprobación explícita.
 */
export async function executeRestorePlan(
  plan: RestorePlan,
  rules: CleanerRuleSet,
  options: { auditPath?: string } = {}
): Promise<RestoreResult> {
  const startedAt = new Date().toISOString();
  const auditPath = path.resolve(options.auditPath ?? DEFAULT_AUDIT_PATH);
  const warnings: string[] = [];
  const items: RestoreResultItem[] = [];
  let restoredCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let conflictCount = 0;
  let restoredBytes = 0;

  for (const item of plan.items) {
    const meta = item.meta;
    const base: AuditRecord = {
      timestamp: new Date().toISOString(),
      target: plan.target,
      relativePath: meta.relativePath,
      risk: meta.risk,
      action: "restore",
      sizeBytes: meta.sizeBytes,
      approvedBy: "human",
      planId: plan.originalPlanId,
      sessionId: plan.sessionId,
      result: "skipped"
    };
    const finish = async (
      result: RestoreResultItem["result"],
      extra: Partial<RestoreResultItem> & {
        error?: string;
        overwritten?: boolean;
      } = {}
    ) => {
      if (result === "restored") {
        restoredCount += 1;
        restoredBytes += meta.sizeBytes;
      } else if (result === "failed") failedCount += 1;
      else if (result === "conflict") conflictCount += 1;
      else skippedCount += 1;
      items.push({
        relativePath: meta.relativePath,
        originalPath: meta.originalPath,
        result,
        risk: meta.risk,
        sizeBytes: meta.sizeBytes,
        ...extra
      });
      const record: AuditRecord = { ...base, result };
      if (extra.error !== undefined) record.error = extra.error;
      if (extra.overwritten) record.overwritten = true;
      await appendAudit(record, auditPath);
    };

    if (!item.approved) {
      await finish("skipped");
      continue;
    }

    try {
      validateRestoreMeta(meta, plan.target, plan.sessionDir, rules);
      if (meta.restored) {
        await finish("skipped", { error: "ya restaurado" });
        continue;
      }
      const storedAbs = path.resolve(plan.sessionDir, meta.storedPath);
      const stored = await lstatOrNull(storedAbs);
      if (!stored) {
        await finish("skipped", {
          error: "el elemento almacenado ya no existe"
        });
        continue;
      }
      if (stored.isSymbolicLink()) {
        throw new Error("el elemento almacenado es un symlink: no se restaura");
      }

      const original = await lstatOrNull(meta.originalPath);
      let destination = meta.originalPath;
      let overwritten = false;

      if (original) {
        if (original.isSymbolicLink()) {
          throw new Error("la ruta original es un symlink: no se sobrescribe");
        }
        if (item.resolution === "cancel") {
          const identical = await identicalFile(storedAbs, meta.originalPath);
          await finish(identical ? "skipped" : "conflict", {
            error: identical
              ? "idéntico ya existe en destino: omitido"
              : "la ruta original ya existe: cancelado (usa suffix u overwrite)"
          });
          continue;
        }
        if (item.resolution === "suffix") {
          destination = await uniqueSuffixPath(meta.originalPath);
          const destRel = path
            .relative(plan.target, destination)
            .replace(/\\/g, "/");
          if (
            classifyPath(destRel, rules).risk === "protected" ||
            classifyPath(destRel, DEFAULT_RULES).risk === "protected"
          ) {
            throw new Error(`destino con sufijo protegido: ${destRel}`);
          }
        } else {
          // overwrite: exige aprobación explícita registrada en el plan.
          if (!plan.overwriteApproved) {
            throw new Error("overwrite no aprobado explícitamente");
          }
          await fs.rm(meta.originalPath, {
            recursive: true,
            force: false,
            maxRetries: 3,
            retryDelay: 200
          });
          overwritten = true;
          warnings.push(`Sobrescrita ruta existente: ${meta.relativePath}`);
        }
      }

      await assertNoSymlinkAncestors(destination, plan.target);
      await moveStoredTo(storedAbs, destination);

      // Actualiza el manifest para reflejar el estado real.
      const manifest = await readManifest(plan.sessionDir);
      const entry = manifest.items.find(
        (candidate) => candidate.storedPath === meta.storedPath
      );
      if (entry) {
        entry.restored = true;
        entry.restoredAt = new Date().toISOString();
        entry.restoredPath = destination;
        await writeManifest(manifest);
      }

      await finish("restored", {
        restoredPath: destination,
        ...(overwritten ? { overwritten: true } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${meta.relativePath}: ${message}`);
      await finish("failed", { error: message });
    }
  }

  return {
    id: randomUUID(),
    target: plan.target,
    sessionId: plan.sessionId,
    originalPlanId: plan.originalPlanId,
    startedAt,
    finishedAt: new Date().toISOString(),
    items,
    restoredCount,
    failedCount,
    skippedCount,
    conflictCount,
    restoredBytes,
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

function parseNumberSelection(
  answer: string,
  count: number
): Set<number> | null {
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "") return null; // Enter = todos
  if (trimmed === "none" || trimmed === "ninguno") return new Set();
  if (trimmed === "all" || trimmed === "todos") {
    return new Set(Array.from({ length: count }, (_, i) => i));
  }
  const numbers = trimmed.split(/[\s,]+/).filter(Boolean);
  const selected = new Set<number>();
  for (const token of numbers) {
    const n = Number(token);
    if (!Number.isInteger(n) || n < 1 || n > count) {
      throw new Error(
        `Selección inválida: "${token}" (1..${count}, all o none)`
      );
    }
    selected.add(n - 1);
  }
  return selected;
}

export interface RestoreSessionOutcome {
  sessions: TrashSessionInfo[];
  session?: TrashSession;
  plan?: RestorePlan;
  result: RestoreResult | null;
  paths?: ReportPaths;
}

export interface RestoreCliOptions extends RestoreOptions, RestoreSelection {
  session?: string;
}

/**
 * Orquestador de `restore`: sesiones -> selección de sesión -> elementos ->
 * selección -> conflictos -> confirmación explícita -> ejecución auditada
 * -> informe final.
 */
export async function restoreRepository(
  target: string,
  rules: CleanerRuleSet,
  options: RestoreCliOptions = {}
): Promise<RestoreSessionOutcome> {
  const absTarget = path.resolve(target);
  const stat = await lstatOrNull(absTarget);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`La ruta no existe o no es un directorio: ${absTarget}`);
  }

  const sessions = await listTrashSessions(absTarget);
  if (sessions.length === 0) {
    console.log("No hay sesiones de papelera en el proyecto.");
    return { sessions, result: null };
  }
  printRestoreSessions(sessions);

  const interactive = options.isInteractive ?? process.stdin.isTTY === true;
  const ask = options.ask ?? defaultAsk;

  let session: TrashSession;
  if (options.session) {
    session = await readTrashSession(absTarget, options.session);
  } else if (sessions.length === 1) {
    session = await readTrashSession(absTarget, sessions[0]?.sessionId ?? "");
  } else {
    if (!interactive || options.yes) {
      throw new Error(
        "Varias sesiones disponibles: indica --session <timestamp> (ver listado)."
      );
    }
    const answer = await ask("\nSelecciona sesión (número): ");
    const selected = parseNumberSelection(answer, sessions.length);
    const index =
      selected && selected.size === 1 ? [...selected][0] : undefined;
    if (index === undefined) {
      throw new Error("Selección de sesión inválida: indica un único número.");
    }
    session = await readTrashSession(
      absTarget,
      sessions[index]?.sessionId ?? ""
    );
  }

  const plan = await createRestorePlan(
    absTarget,
    session,
    { only: options.only, all: options.all },
    { onConflict: options.onConflict }
  );

  // Selección interactiva de elementos (si no hay --only/--all/--yes).
  if (!options.yes && !options.only?.length && !options.all && interactive) {
    printRestorePlan(plan, session);
    const answer = await ask(
      "\nRestaurar [Enter = todos los pendientes / números / none]: "
    );
    const selected = parseNumberSelection(answer, plan.items.length);
    if (selected) {
      plan.items.forEach((item, index) => {
        item.approved = selected.has(index);
      });
    }
  } else {
    printRestorePlan(plan, session);
  }

  const approved = plan.items.filter((item) => item.approved);
  if (approved.length === 0) {
    console.log("Selección vacía: no se restaura nada.");
    return { sessions, session, plan, result: null };
  }

  // Conflictos: overwrite requiere confirmación adicional explícita.
  const overwrites = approved.filter(
    (item) => item.conflict && item.resolution === "overwrite"
  );
  if (overwrites.length > 0) {
    if (options.yes) {
      // Automatización consciente: el flag --on-conflict overwrite es la
      // elección explícita; se muestra el plan antes de ejecutar.
      plan.overwriteApproved = options.onConflict === "overwrite";
    } else if (interactive) {
      const answer = await ask(
        `⚠ ${overwrites.length} rutas existentes se SOBRESCRIBIRÁN. Escribe "overwrite" para autorizarlo: `
      );
      plan.overwriteApproved = answer.trim().toLowerCase() === "overwrite";
    }
    if (!plan.overwriteApproved) {
      console.log("Sobrescritura no autorizada: operación cancelada.");
      return { sessions, session, plan, result: null };
    }
  }

  if (options.dryRun) {
    console.log("\nDry-run: no se ha restaurado nada.");
    return { sessions, session, plan, result: null };
  }

  if (!options.yes) {
    if (!interactive) {
      throw new Error(
        "Sin terminal interactivo y sin --yes: no se puede confirmar la restauración."
      );
    }
    const bytes = approved.reduce((acc, item) => acc + item.meta.sizeBytes, 0);
    const confirmation = await ask(
      `¿Confirmas restaurar ${approved.length} elementos (${formatBytes(bytes)}) a sus rutas originales? Escribe "yes" o "sí": `
    );
    if (!/^(yes|sí|si)$/i.test(confirmation.trim())) {
      console.log("Operación cancelada: no se ha tocado nada.");
      return { sessions, session, plan, result: null };
    }
  } else {
    console.log(
      `\n--yes activo: restauración automática de ${approved.length} elementos.`
    );
  }

  const result = await executeRestorePlan(plan, rules, {
    auditPath: options.auditPath
  });
  const paths = await saveRestoreResult(result, options.reportsDir);
  printRestoreResult(result, paths);
  return { sessions, session, plan, result, paths };
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  CleanPlan,
  ScanEntry,
  TrashItemMeta,
  TrashSession
} from "../types/index.js";

export const TRASH_DIR_NAME = ".repo-cleaner-trash";

/** Huella SHA-256 del plan (evidencia que vincula papelera y aprobación). */
export function planHashOf(plan: CleanPlan): string {
  const canonical = JSON.stringify({
    id: plan.id,
    target: plan.target,
    scanReportId: plan.scanReportId,
    createdAt: plan.createdAt,
    items: plan.items.map((item) => ({
      relativePath: item.entry.relativePath,
      risk: item.entry.risk,
      action: item.action,
      approved: item.approved,
      sizeBytes: item.entry.sizeBytes
    }))
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

async function writeManifest(session: TrashSession): Promise<void> {
  await fs.writeFile(
    path.join(session.sessionDir, "manifest.json"),
    JSON.stringify(session, null, 2) + "\n",
    "utf8"
  );
}

/**
 * Crea la sesión de papelera `.repo-cleaner-trash/<timestamp>/` dentro del
 * proyecto objetivo (o en una ruta configurable). Nunca dentro de un
 * elemento que se vaya a mover.
 */
export async function createTrashSession(
  target: string,
  plan: CleanPlan,
  trashDir?: string
): Promise<TrashSession> {
  const absTarget = path.resolve(target);
  const root = trashDir
    ? path.resolve(trashDir)
    : path.join(absTarget, TRASH_DIR_NAME);

  for (const item of plan.items) {
    const abs = item.entry.absolutePath;
    if (root === abs || root.startsWith(abs + path.sep)) {
      throw new Error(
        `Papelera insegura: ${root} está dentro del elemento a mover ${abs}`
      );
    }
  }

  const base = path.join(root, stamp(new Date()));
  let sessionDir = base;
  let suffix = 2;
  while (await fs.stat(sessionDir).catch(() => null)) {
    sessionDir = `${base}-${suffix}`;
    suffix += 1;
  }
  const itemsDir = path.join(sessionDir, "items");
  await fs.mkdir(itemsDir, { recursive: true });

  const session: TrashSession = {
    id: randomUUID(),
    target: absTarget,
    createdAt: new Date().toISOString(),
    planId: plan.id,
    planHash: planHashOf(plan),
    sessionDir,
    itemsDir,
    items: []
  };
  await writeManifest(session);
  return session;
}

/**
 * Mueve un elemento a la papelera conservando metadatos completos.
 * El Safety Guard debe haberse aplicado antes (lo hace el Cleaner).
 * Aquí se rechazan de nuevo rutas protegidas o fuera del objetivo.
 */
export async function trashItem(
  session: TrashSession,
  entry: ScanEntry,
  planHash: string
): Promise<TrashItemMeta> {
  if (entry.risk === "protected") {
    throw new Error(
      `Papelera: nunca se mueven rutas protegidas (${entry.relativePath})`
    );
  }
  const relative = path.relative(session.target, entry.absolutePath);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    entry.absolutePath.split(/[\\/]/).includes("..")
  ) {
    throw new Error(
      `Papelera: ruta fuera del objetivo (${entry.absolutePath})`
    );
  }

  const index = String(session.items.length + 1).padStart(4, "0");
  const storedName = `${index}-${path.basename(entry.absolutePath)}`;
  const destination = path.join(session.itemsDir, storedName);

  try {
    await fs.rename(entry.absolutePath, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EXDEV") {
      // Otro volumen: copiar y verificar antes de retirar el original.
      await fs.cp(entry.absolutePath, destination, { recursive: true });
      await fs.rm(entry.absolutePath, {
        recursive: true,
        force: false,
        maxRetries: 3,
        retryDelay: 200
      });
    } else {
      throw error;
    }
  }

  const meta: TrashItemMeta = {
    originalPath: entry.absolutePath,
    relativePath: entry.relativePath,
    storedPath: path
      .relative(session.sessionDir, destination)
      .replace(/\\/g, "/"),
    timestamp: new Date().toISOString(),
    sizeBytes: entry.sizeBytes,
    risk: entry.risk,
    action: "trash",
    reason: entry.reason,
    planHash
  };
  session.items.push(meta);
  // Manifest reescrito tras cada movimiento: resistente a interrupciones.
  await writeManifest(session);
  return meta;
}

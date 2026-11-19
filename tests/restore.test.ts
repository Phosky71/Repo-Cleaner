import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRestorePlan,
  executeRestorePlan,
  listTrashSessions,
  readTrashSession,
  restoreRepository,
  validateRestoreMeta
} from "../src/core/restore.js";
import { createCleanPlan, executeCleanPlan } from "../src/core/cleaner.js";
import { scanProject } from "../src/core/scanner.js";
import { readAudit } from "../src/core/audit.js";
import { DEFAULT_RULES } from "../src/rules/defaults.js";
import type { TrashSession } from "../src/types/index.js";
import { makeFixture, testRules, writeFixtureFile } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

interface TrashedFixture {
  root: string;
  target: string;
  auditPath: string;
  reportsDir: string;
  session: TrashSession;
  sessionId: string;
}

/** Proyecto con node_modules/dist/debug.log ya movidos a la papelera. */
async function trashedFixture(): Promise<TrashedFixture> {
  const root = await makeFixture();
  tempDirs.push(root);
  const aux = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-rest-"));
  tempDirs.push(aux);
  const target = path.join(root, "proj-node");
  const auditPath = path.join(aux, "audit.jsonl");
  const reportsDir = path.join(aux, "reports");

  const report = await scanProject(target, testRules());
  const plan = createCleanPlan(report);
  const result = await executeCleanPlan(plan, testRules(), { auditPath });
  const sessionId = path.basename(result.trashSessionDir ?? "");
  const session = await readTrashSession(target, sessionId);
  return { root, target, auditPath, reportsDir, session, sessionId };
}

describe("listado y detalle de sesiones", () => {
  it("lista sesiones con estado, tamaños y hash del plan", async () => {
    const { target, session } = await trashedFixture();
    const sessions = await listTrashSessions(target);
    expect(sessions).toHaveLength(1);
    const info = sessions[0];
    expect(info?.sessionId).toBe(path.basename(session.sessionDir));
    expect(info?.itemCount).toBe(3);
    expect(info?.pendingCount).toBe(3);
    expect(info?.restorableCount).toBe(3);
    expect(info?.status).toBe("restorable");
    expect(info?.totalBytes).toBeGreaterThan(0);
    expect(info?.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lee el detalle de una sesión y rechaza IDs o targets inválidos", async () => {
    const { target, sessionId, root } = await trashedFixture();
    const session = await readTrashSession(target, sessionId);
    expect(session.items).toHaveLength(3);
    await expect(readTrashSession(target, "no-es-id")).rejects.toThrow(
      /sessionId inválido/
    );
    await expect(readTrashSession(target, "19990101-000000")).rejects.toThrow(
      /no existe/
    );
    // Sesión copiada bajo otro proyecto: el manifest delata el target real.
    const otro = path.join(root, "otro-proyecto");
    await fs.cp(
      session.sessionDir,
      path.join(otro, ".repo-cleaner-trash", sessionId),
      { recursive: true }
    );
    await expect(readTrashSession(otro, sessionId)).rejects.toThrow(
      /otro proyecto/
    );
  });

  it("sin papelera devuelve lista vacía", async () => {
    const root = await makeFixture();
    tempDirs.push(root);
    expect(await listTrashSessions(path.join(root, "proj-py"))).toEqual([]);
  });
});

describe("restauración completa y parcial", () => {
  it("restaura todo a las rutas originales, actualiza manifest y audita", async () => {
    const { target, session, auditPath, sessionId } = await trashedFixture();
    const plan = await createRestorePlan(target, session, { all: true });
    const result = await executeRestorePlan(plan, testRules(), { auditPath });

    expect(result.restoredCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(result.restoredBytes).toBe(plan.totalBytes);
    expect(await fs.stat(path.join(target, "node_modules"))).toBeTruthy();
    expect(await fs.stat(path.join(target, "dist"))).toBeTruthy();
    expect(await fs.stat(path.join(target, "debug.log"))).toBeTruthy();

    // Manifest actualizado: todos restaurados con destino y fecha.
    const updated = await readTrashSession(target, sessionId);
    for (const item of updated.items) {
      expect(item.restored).toBe(true);
      expect(item.restoredAt).toBeTruthy();
      expect(item.restoredPath).toBeTruthy();
    }
    // La sesión se conserva (evidencia), ya no restaurable.
    const sessions = await listTrashSessions(target);
    expect(sessions[0]?.status).toBe("restored");
    expect(sessions[0]?.pendingCount).toBe(0);

    // Auditoría de restauración con el formato exigido.
    const records = await readAudit(auditPath);
    const restoreRecords = records.filter((r) => r.action === "restore");
    expect(restoreRecords).toHaveLength(3);
    for (const record of restoreRecords) {
      expect(record.result).toBe("restored");
      expect(record.approvedBy).toBe("human");
      expect(record.sessionId).toBe(sessionId);
      expect(record.planId).toBe(session.planId);
      expect(record.risk).toBe("safe");
      expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
    }
  });

  it("restauración parcial con --only deja el resto en la papelera", async () => {
    const { target, session, auditPath, sessionId } = await trashedFixture();
    const plan = await createRestorePlan(target, session, { only: ["dist"] });
    expect(plan.items).toHaveLength(1);
    const result = await executeRestorePlan(plan, testRules(), { auditPath });
    expect(result.restoredCount).toBe(1);
    expect(await fs.stat(path.join(target, "dist"))).toBeTruthy();
    await expect(fs.stat(path.join(target, "node_modules"))).rejects.toThrow();

    const updated = await readTrashSession(target, sessionId);
    const dist = updated.items.find((i) => i.relativePath === "dist");
    const nm = updated.items.find((i) => i.relativePath === "node_modules");
    expect(dist?.restored).toBe(true);
    expect(nm?.restored).toBeFalsy();
    const sessions = await listTrashSessions(target);
    expect(sessions[0]?.status).toBe("partial");
    expect(sessions[0]?.pendingCount).toBe(2);
  });

  it("rechaza rutas desconocidas en --only", async () => {
    const { target, session } = await trashedFixture();
    await expect(
      createRestorePlan(target, session, { only: ["fantasma"] })
    ).rejects.toThrow(/no presentes/);
  });
});

describe("restauración — seguridad", () => {
  it("rechaza metadatos con rutas fuera del target", async () => {
    const { target, session } = await trashedFixture();
    const meta = { ...session.items[0]! };
    meta.originalPath = path.join(os.tmpdir(), "fuera-del-target");
    meta.relativePath = "fuera-del-target";
    expect(() =>
      validateRestoreMeta(meta, target, session.sessionDir, DEFAULT_RULES)
    ).toThrow(/fuera del objetivo/);
  });

  it("rechaza metadatos con ..", async () => {
    const { target, session } = await trashedFixture();
    const meta = { ...session.items[0]! };
    meta.relativePath = "../escape";
    expect(() =>
      validateRestoreMeta(meta, target, session.sessionDir, DEFAULT_RULES)
    ).toThrow(/\.\./);
  });

  it("rechaza restaurar sobre rutas protegidas (.git, .env, src)", async () => {
    const { target, session } = await trashedFixture();
    for (const protegida of [".git", ".env", "src"]) {
      const meta = { ...session.items[0]! };
      meta.relativePath = protegida;
      meta.originalPath = path.join(target, protegida);
      expect(() =>
        validateRestoreMeta(meta, target, session.sessionDir, DEFAULT_RULES)
      ).toThrow(/protegida/);
    }
  });

  it("rechaza storedPath que escapa de la sesión", async () => {
    const { target, session } = await trashedFixture();
    const meta = { ...session.items[0]! };
    meta.storedPath = "../../evil";
    expect(() =>
      validateRestoreMeta(meta, target, session.sessionDir, DEFAULT_RULES)
    ).toThrow(/\.\./);
  });

  it("elemento almacenado inexistente: skipped, no restaurable", async () => {
    const { target, session, auditPath, sessionId } = await trashedFixture();
    const dist = session.items.find((i) => i.relativePath === "dist");
    await fs.rm(path.resolve(session.sessionDir, dist?.storedPath ?? ""), {
      recursive: true
    });
    const plan = await createRestorePlan(target, session, { only: ["dist"] });
    expect(plan.items[0]?.storedExists).toBe(false);
    const result = await executeRestorePlan(plan, testRules(), { auditPath });
    expect(result.skippedCount).toBe(1);
    expect(result.restoredCount).toBe(0);
    const records = await readAudit(auditPath);
    const restore = records.filter((r) => r.action === "restore");
    expect(restore[0]?.result).toBe("skipped");
    const sessions = await listTrashSessions(target);
    expect(sessions[0]?.restorableCount).toBe(2);
    expect(sessionId).toBeTruthy();
  });
});

describe("restauración — conflictos en destino", () => {
  it("cancel: no toca el destino existente y registra conflict", async () => {
    const { target, session, auditPath } = await trashedFixture();
    await writeFixtureFile(target, "dist/nuevo.js", "contenido nuevo");
    const plan = await createRestorePlan(
      target,
      session,
      { only: ["dist"] },
      { onConflict: "cancel" }
    );
    expect(plan.items[0]?.conflict).toBe(true);
    const result = await executeRestorePlan(plan, testRules(), { auditPath });
    expect(result.conflictCount).toBe(1);
    expect(result.restoredCount).toBe(0);
    expect(await fs.readFile(path.join(target, "dist/nuevo.js"), "utf8")).toBe(
      "contenido nuevo"
    );
    const records = await readAudit(auditPath);
    const restore = records.filter((r) => r.action === "restore");
    expect(restore[0]?.result).toBe("conflict");
  });

  it("suffix: restaura con nombre único sin tocar el existente", async () => {
    const { target, session, auditPath } = await trashedFixture();
    await writeFixtureFile(target, "dist/nuevo.js", "contenido nuevo");
    const plan = await createRestorePlan(
      target,
      session,
      { only: ["dist"] },
      { onConflict: "suffix" }
    );
    const result = await executeRestorePlan(plan, testRules(), { auditPath });
    expect(result.restoredCount).toBe(1);
    const restoredPath = result.items[0]?.restoredPath ?? "";
    expect(restoredPath).toContain("dist.restored-");
    expect(await fs.stat(restoredPath)).toBeTruthy();
    expect(await fs.readFile(path.join(target, "dist/nuevo.js"), "utf8")).toBe(
      "contenido nuevo"
    );
  });

  it("overwrite sin aprobación explícita: fallido y destino intacto", async () => {
    const { target, session, auditPath } = await trashedFixture();
    await writeFixtureFile(target, "dist/nuevo.js", "contenido nuevo");
    const plan = await createRestorePlan(
      target,
      session,
      { only: ["dist"] },
      { onConflict: "overwrite" } // overwriteApproved por defecto false
    );
    const result = await executeRestorePlan(plan, testRules(), { auditPath });
    expect(result.failedCount).toBe(1);
    expect(result.items[0]?.error).toMatch(/no aprobado/);
    expect(await fs.readFile(path.join(target, "dist/nuevo.js"), "utf8")).toBe(
      "contenido nuevo"
    );
  });

  it("overwrite aprobado: reemplaza el destino y lo audita", async () => {
    const { target, session, auditPath } = await trashedFixture();
    await writeFixtureFile(target, "dist/nuevo.js", "contenido nuevo");
    const plan = await createRestorePlan(
      target,
      session,
      { only: ["dist"] },
      { onConflict: "overwrite", overwriteApproved: true }
    );
    const result = await executeRestorePlan(plan, testRules(), { auditPath });
    expect(result.restoredCount).toBe(1);
    await expect(fs.stat(path.join(target, "dist/nuevo.js"))).rejects.toThrow();
    expect(await fs.stat(path.join(target, "dist/index.js"))).toBeTruthy();
    const records = await readAudit(auditPath);
    const restore = records.filter((r) => r.action === "restore");
    expect(restore[0]?.result).toBe("restored");
    expect(restore[0]?.overwritten).toBe(true);
  });

  it("destino idéntico con cancel: se omite (skipped)", async () => {
    const { target, session, auditPath } = await trashedFixture();
    // debug.log original contenía "traza"; se recrea idéntico.
    await writeFixtureFile(target, "debug.log", "traza");
    const plan = await createRestorePlan(
      target,
      session,
      { only: ["debug.log"] },
      { onConflict: "cancel" }
    );
    const result = await executeRestorePlan(plan, testRules(), { auditPath });
    expect(result.skippedCount).toBe(1);
    expect(result.items[0]?.error).toMatch(/idéntico/);
  });
});

describe("restoreRepository — human-in-the-loop", () => {
  function answers(...responses: string[]) {
    let index = 0;
    return async () => {
      const response = responses[index] ?? "";
      index += 1;
      return response;
    };
  }

  it("dry-run no restaura nada", async () => {
    const { target, auditPath, reportsDir, sessionId } = await trashedFixture();
    const outcome = await restoreRepository(target, testRules(), {
      session: sessionId,
      all: true,
      dryRun: true,
      auditPath,
      reportsDir
    });
    expect(outcome.result).toBeNull();
    await expect(fs.stat(path.join(target, "node_modules"))).rejects.toThrow();
  });

  it("confirmación negativa no restaura nada", async () => {
    const { target, auditPath, reportsDir, sessionId } = await trashedFixture();
    const outcome = await restoreRepository(target, testRules(), {
      session: sessionId,
      isInteractive: true,
      ask: answers("", "no"),
      auditPath,
      reportsDir
    });
    expect(outcome.result).toBeNull();
    await expect(fs.stat(path.join(target, "node_modules"))).rejects.toThrow();
  });

  it("selección 'none' cancela sin tocar nada", async () => {
    const { target, auditPath, reportsDir, sessionId } = await trashedFixture();
    const outcome = await restoreRepository(target, testRules(), {
      session: sessionId,
      isInteractive: true,
      ask: answers("none"),
      auditPath,
      reportsDir
    });
    expect(outcome.result).toBeNull();
  });

  it("confirmación positiva restaura y genera informe", async () => {
    const { target, auditPath, reportsDir, sessionId } = await trashedFixture();
    const outcome = await restoreRepository(target, testRules(), {
      session: sessionId,
      isInteractive: true,
      ask: answers("", "yes"),
      auditPath,
      reportsDir
    });
    expect(outcome.result?.restoredCount).toBe(3);
    expect(outcome.paths).toBeDefined();
    expect(await fs.stat(path.join(target, "node_modules"))).toBeTruthy();
  });

  it("--yes con --only restaura sin prompts", async () => {
    const { target, auditPath, reportsDir, sessionId } = await trashedFixture();
    const outcome = await restoreRepository(target, testRules(), {
      session: sessionId,
      only: ["dist"],
      yes: true,
      isInteractive: false,
      auditPath,
      reportsDir
    });
    expect(outcome.result?.restoredCount).toBe(1);
    expect(await fs.stat(path.join(target, "dist"))).toBeTruthy();
  });

  it("overwrite interactivo requiere escribir 'overwrite'", async () => {
    const { target, auditPath, reportsDir, sessionId } = await trashedFixture();
    await writeFixtureFile(target, "dist/nuevo.js", "nuevo");
    // Preguntas: selección elementos (Enter), autorización overwrite, confirmación.
    const outcome = await restoreRepository(target, testRules(), {
      session: sessionId,
      only: ["dist"],
      onConflict: "overwrite",
      isInteractive: true,
      ask: answers("overwrite", "yes"),
      auditPath,
      reportsDir
    });
    expect(outcome.result?.restoredCount).toBe(1);
    await expect(fs.stat(path.join(target, "dist/nuevo.js"))).rejects.toThrow();
  });

  it("overwrite no autorizado cancela la operación", async () => {
    const { target, auditPath, reportsDir, sessionId } = await trashedFixture();
    await writeFixtureFile(target, "dist/nuevo.js", "nuevo");
    const outcome = await restoreRepository(target, testRules(), {
      session: sessionId,
      only: ["dist"],
      onConflict: "overwrite",
      isInteractive: true,
      ask: answers("no quiero", "yes"),
      auditPath,
      reportsDir
    });
    expect(outcome.result).toBeNull();
    expect(await fs.readFile(path.join(target, "dist/nuevo.js"), "utf8")).toBe(
      "nuevo"
    );
  });
});

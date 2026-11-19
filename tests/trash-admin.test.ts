import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessSessionEligibility,
  purgeTrashSession,
  trashRepository
} from "../src/core/trash-admin.js";
import { createCleanPlan, executeCleanPlan } from "../src/core/cleaner.js";
import {
  createRestorePlan,
  executeRestorePlan,
  listTrashSessions,
  readTrashSession
} from "../src/core/restore.js";
import { scanProject } from "../src/core/scanner.js";
import { readAudit } from "../src/core/audit.js";
import type { TrashPurgeReport } from "../src/types/index.js";
import { makeFixture, testRules } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  target: string;
  auditPath: string;
  reportsDir: string;
  sessionId: string;
}

/** Proyecto con una sesión de papelera recién creada (3 safe movidos). */
async function trashedFixture(): Promise<Fixture> {
  const root = await makeFixture();
  tempDirs.push(root);
  const aux = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-trash-"));
  tempDirs.push(aux);
  const target = path.join(root, "proj-node");
  const auditPath = path.join(aux, "audit.jsonl");
  const reportsDir = path.join(aux, "reports");
  const report = await scanProject(target, testRules());
  const plan = createCleanPlan(report);
  const result = await executeCleanPlan(plan, testRules(), { auditPath });
  const sessionId = path.basename(result.trashSessionDir ?? "");
  return { root, target, auditPath, reportsDir, sessionId };
}

async function restoreAll(fixture: Fixture): Promise<void> {
  const session = await readTrashSession(fixture.target, fixture.sessionId);
  const plan = await createRestorePlan(fixture.target, session, { all: true });
  await executeRestorePlan(plan, testRules(), { auditPath: fixture.auditPath });
}

async function cleanAgain(fixture: Fixture): Promise<string> {
  const report = await scanProject(fixture.target, testRules());
  const plan = createCleanPlan(report);
  const result = await executeCleanPlan(plan, testRules(), {
    auditPath: fixture.auditPath
  });
  return path.basename(result.trashSessionDir ?? "");
}

describe("trash — listado y detalle", () => {
  it("lista sesiones con contadores, estado y hash", async () => {
    const fixture = await trashedFixture();
    const outcome = await trashRepository(fixture.target, {});
    expect(outcome.sessions).toHaveLength(1);
    const info = outcome.sessions[0];
    expect(info?.sessionId).toBe(fixture.sessionId);
    expect(info?.itemCount).toBe(3);
    expect(info?.pendingCount).toBe(3);
    expect(info?.restoredCount).toBe(0);
    expect(info?.restorableCount).toBe(3);
    expect(info?.status).toBe("restorable");
    expect(info?.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.report).toBeUndefined();
  });

  it("inspecciona una sesión concreta sin eliminar nada", async () => {
    const fixture = await trashedFixture();
    const outcome = await trashRepository(fixture.target, {
      session: fixture.sessionId
    });
    expect(outcome.sessions).toHaveLength(1);
    expect(outcome.report).toBeUndefined();
    const sessionDir = path.join(
      fixture.target,
      ".repo-cleaner-trash",
      fixture.sessionId
    );
    expect(await fs.stat(sessionDir)).toBeTruthy();
  });

  it("estados restored, partial y unrestorable", async () => {
    const restored = await trashedFixture();
    await restoreAll(restored);
    expect((await listTrashSessions(restored.target))[0]?.status).toBe(
      "restored"
    );

    const partial = await trashedFixture();
    const session = await readTrashSession(partial.target, partial.sessionId);
    const plan = await createRestorePlan(partial.target, session, {
      only: ["dist"]
    });
    await executeRestorePlan(plan, testRules(), {
      auditPath: partial.auditPath
    });
    const partialInfo = (await listTrashSessions(partial.target))[0];
    expect(partialInfo?.status).toBe("partial");
    expect(partialInfo?.restoredCount).toBe(1);

    const unrestorable = await trashedFixture();
    const session2 = await readTrashSession(
      unrestorable.target,
      unrestorable.sessionId
    );
    for (const item of session2.items) {
      await fs.rm(path.resolve(session2.sessionDir, item.storedPath), {
        recursive: true
      });
    }
    const info = (await listTrashSessions(unrestorable.target))[0];
    expect(info?.status).toBe("unrestorable");
    expect(info?.restorableCount).toBe(0);
    expect(assessSessionEligibility(info!).removable).toBe(true);
  });
});

describe("trash — elegibilidad y seguridad", () => {
  it("rechaza eliminar sesiones con elementos pendientes", async () => {
    const fixture = await trashedFixture();
    const result = await purgeTrashSession(fixture.target, fixture.sessionId, {
      auditPath: fixture.auditPath
    });
    expect(result.result).toBe("skipped");
    expect(result.error).toMatch(/pendientes/);
    const sessionDir = path.join(
      fixture.target,
      ".repo-cleaner-trash",
      fixture.sessionId
    );
    expect(await fs.stat(sessionDir)).toBeTruthy();
    const records = await readAudit(fixture.auditPath);
    const purges = records.filter((r) => r.action === "purge");
    expect(purges[0]?.result).toBe("skipped");
  });

  it("rechaza sessionId inválido, con .. o de otro proyecto", async () => {
    const fixture = await trashedFixture();
    const invalid = await purgeTrashSession(fixture.target, "../evil", {
      auditPath: fixture.auditPath
    });
    expect(invalid.result).toBe("skipped");
    const foreign = await purgeTrashSession(fixture.root, fixture.sessionId, {
      auditPath: fixture.auditPath
    });
    expect(foreign.result).toBe("skipped");
    const sessionDir = path.join(
      fixture.target,
      ".repo-cleaner-trash",
      fixture.sessionId
    );
    expect(await fs.stat(sessionDir)).toBeTruthy();
  });

  it("trashRepository valida que el target exista", async () => {
    const fixture = await trashedFixture();
    await expect(
      trashRepository(path.join(fixture.root, "fantasma"), {})
    ).rejects.toThrow(/no existe/);
  });
});

describe("trash — purga con confirmación", () => {
  it("elimina una sesión completada con confirmación, audita e informa", async () => {
    const fixture = await trashedFixture();
    await restoreAll(fixture);
    const outcome = await trashRepository(fixture.target, {
      session: fixture.sessionId,
      remove: true,
      isInteractive: true,
      ask: async () => "yes",
      auditPath: fixture.auditPath,
      reportsDir: fixture.reportsDir
    });
    expect(outcome.report).toBeDefined();
    expect(outcome.report?.purged[0]?.result).toBe("purged");
    expect(outcome.report?.freedBytes).toBeGreaterThan(0);
    const sessionDir = path.join(
      fixture.target,
      ".repo-cleaner-trash",
      fixture.sessionId
    );
    await expect(fs.stat(sessionDir)).rejects.toThrow();

    // Auditoría purge con el formato exigido (se conserva tras borrar).
    const records = await readAudit(fixture.auditPath);
    const purge = records.find((r) => r.action === "purge");
    expect(purge?.result).toBe("purged");
    expect(purge?.risk).toBe("safe");
    expect(purge?.approvedBy).toBe("human");
    expect(purge?.sessionId).toBe(fixture.sessionId);
    expect(purge?.relativePath).toBe(
      `.repo-cleaner-trash/${fixture.sessionId}`
    );

    // Informes JSON y Markdown.
    expect(outcome.paths).toBeDefined();
    const stored = JSON.parse(
      await fs.readFile(outcome.paths?.json ?? "", "utf8")
    ) as TrashPurgeReport;
    expect(stored.purged[0]?.result).toBe("purged");
    expect(stored.eligible).toContain(fixture.sessionId);
    const markdown = await fs.readFile(outcome.paths?.markdown ?? "", "utf8");
    expect(markdown).toContain("Informe de gestión de papelera");
    expect(markdown).toContain(fixture.sessionId);
  });

  it("remove-completed elimina solo las sesiones seguras", async () => {
    const fixture = await trashedFixture();
    await restoreAll(fixture);
    const pendingSession = await cleanAgain(fixture);
    const outcome = await trashRepository(fixture.target, {
      removeCompleted: true,
      yes: true,
      isInteractive: false,
      auditPath: fixture.auditPath,
      reportsDir: fixture.reportsDir
    });
    expect(outcome.report?.purged).toHaveLength(1);
    expect(outcome.report?.purged[0]?.sessionId).toBe(fixture.sessionId);
    expect(outcome.report?.kept).toContain(pendingSession);
    const remaining = await listTrashSessions(fixture.target);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.sessionId).toBe(pendingSession);
    expect(remaining[0]?.status).toBe("restorable");
  });

  it("elimina sesiones no restaurables (almacén ausente)", async () => {
    const fixture = await trashedFixture();
    const session = await readTrashSession(fixture.target, fixture.sessionId);
    for (const item of session.items) {
      await fs.rm(path.resolve(session.sessionDir, item.storedPath), {
        recursive: true
      });
    }
    const outcome = await trashRepository(fixture.target, {
      session: fixture.sessionId,
      remove: true,
      yes: true,
      isInteractive: false,
      auditPath: fixture.auditPath,
      reportsDir: fixture.reportsDir
    });
    expect(outcome.report?.purged[0]?.result).toBe("purged");
    expect(await listTrashSessions(fixture.target)).toEqual([]);
  });

  it("confirmación negativa: no elimina nada", async () => {
    const fixture = await trashedFixture();
    await restoreAll(fixture);
    const outcome = await trashRepository(fixture.target, {
      session: fixture.sessionId,
      remove: true,
      isInteractive: true,
      ask: async () => "no",
      auditPath: fixture.auditPath,
      reportsDir: fixture.reportsDir
    });
    expect(outcome.report).toBeUndefined();
    expect(await listTrashSessions(fixture.target)).toHaveLength(1);
  });

  it("dry-run no elimina ni audita", async () => {
    const fixture = await trashedFixture();
    await restoreAll(fixture);
    const before = (await readAudit(fixture.auditPath)).length;
    const outcome = await trashRepository(fixture.target, {
      session: fixture.sessionId,
      remove: true,
      dryRun: true,
      auditPath: fixture.auditPath,
      reportsDir: fixture.reportsDir
    });
    expect(outcome.report).toBeUndefined();
    expect(await listTrashSessions(fixture.target)).toHaveLength(1);
    expect((await readAudit(fixture.auditPath)).length).toBe(before);
  });

  it("sin TTY y sin --yes se niega a eliminar", async () => {
    const fixture = await trashedFixture();
    await restoreAll(fixture);
    await expect(
      trashRepository(fixture.target, {
        session: fixture.sessionId,
        remove: true,
        isInteractive: false,
        auditPath: fixture.auditPath
      })
    ).rejects.toThrow(/interactivo/);
    expect(await listTrashSessions(fixture.target)).toHaveLength(1);
  });

  it("--remove sin --session es un error", async () => {
    const fixture = await trashedFixture();
    await expect(
      trashRepository(fixture.target, { remove: true, yes: true })
    ).rejects.toThrow(/--session/);
  });
});

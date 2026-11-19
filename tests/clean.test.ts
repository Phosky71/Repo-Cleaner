import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyInteractiveSelection,
  createCleanPlan,
  executeCleanPlan
} from "../src/core/cleaner.js";
import { readAudit } from "../src/core/audit.js";
import { scanProject } from "../src/core/scanner.js";
import type { CleanPlan, TrashSession } from "../src/types/index.js";
import { makeFixture, testRules, writeFixtureFile } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function fixture(): Promise<{ root: string; target: string }> {
  const root = await makeFixture();
  tempDirs.push(root);
  const target = path.join(root, "proj-node");
  // docs/ y tests/ para las pruebas de protección.
  await writeFixtureFile(target, "docs/nota.md", "documentación");
  await writeFixtureFile(target, "tests/algo.test.js", "test");
  return { root, target };
}

async function tempAudit(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-audit-"));
  tempDirs.push(dir);
  return path.join(dir, "clean-audit.jsonl");
}

describe("createCleanPlan", () => {
  it("por defecto solo incluye elementos safe", async () => {
    const { target } = await fixture();
    const report = await scanProject(target, testRules());
    const plan = await createCleanPlan(report, testRules());
    expect(plan.items.length).toBeGreaterThan(0);
    for (const item of plan.items) {
      expect(item.entry.risk).toBe("safe");
      expect(item.action).toBe("trash");
      expect(item.approved).toBe(true);
    }
    const paths = plan.items.map((i) => i.entry.relativePath);
    expect(paths).toContain("node_modules");
    expect(paths).toContain("dist");
    expect(paths).toContain("debug.log");
    expect(paths).not.toContain("datos.bin");
    expect(plan.totalBytes).toBe(
      plan.items.reduce((acc, i) => acc + i.entry.sizeBytes, 0)
    );
  });

  it("includeReview añade los review; protected nunca aparece", async () => {
    const { target } = await fixture();
    const report = await scanProject(target, testRules());
    const plan = await createCleanPlan(report, testRules(), {
      includeReview: true
    });
    const paths = plan.items.map((i) => i.entry.relativePath);
    expect(paths).toContain("datos.bin");
    expect(paths).not.toContain(".git");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("src");
  });

  it("only permite selección individual (incluido review explícito)", async () => {
    const { target } = await fixture();
    const report = await scanProject(target, testRules());
    const plan = await createCleanPlan(report, testRules(), {
      only: ["dist", "datos.bin"]
    });
    expect(plan.items.map((i) => i.entry.relativePath).sort()).toEqual([
      "datos.bin",
      "dist"
    ]);
  });

  it("only rechaza rutas protegidas (.git, .env, src, docs, tests)", async () => {
    const { target } = await fixture();
    const report = await scanProject(target, testRules());
    for (const protegida of [".git", ".env", "src", "docs", "tests"]) {
      await expect(
        createCleanPlan(report, testRules(), { only: [protegida] })
      ).rejects.toThrow(/protegido/);
    }
  });

  it("only rechaza rutas inexistentes en el análisis", async () => {
    const { target } = await fixture();
    const report = await scanProject(target, testRules());
    await expect(
      createCleanPlan(report, testRules(), { only: ["fantasma"] })
    ).rejects.toThrow(/no aparece/);
  });

  it("exclude retira elementos del plan", async () => {
    const { target } = await fixture();
    const report = await scanProject(target, testRules());
    const plan = await createCleanPlan(report, testRules(), {
      exclude: ["dist", "debug.log"]
    });
    const paths = plan.items.map((i) => i.entry.relativePath);
    expect(paths).toContain("node_modules");
    expect(paths).not.toContain("dist");
    expect(paths).not.toContain("debug.log");
  });

  it("deduplica anidados: el directorio padre gana al descendiente", async () => {
    const { target } = await fixture();
    await writeFixtureFile(target, "tmp/node_modules/paquete/index.js", "x");
    const report = await scanProject(target, testRules());
    const plan = await createCleanPlan(report, testRules(), {
      includeReview: true
    });
    const paths = plan.items.map((i) => i.entry.relativePath);
    expect(paths).toContain("tmp");
    expect(paths).not.toContain("tmp/node_modules");
  });

  it("la selección interactiva admite números, all y none", async () => {
    const { target } = await fixture();
    const report = await scanProject(target, testRules());
    const plan = await createCleanPlan(report, testRules());
    const total = plan.items.length;

    applyInteractiveSelection(plan, "none");
    expect(plan.items.every((i) => !i.approved)).toBe(true);

    applyInteractiveSelection(plan, "all");
    expect(plan.items.every((i) => i.approved)).toBe(true);

    applyInteractiveSelection(plan, "1, 2");
    expect(plan.items.filter((i) => i.approved)).toHaveLength(2);
    expect(plan.items[0]?.approved).toBe(true);
    expect(plan.items[total - 1]?.approved).toBe(false);

    expect(() => applyInteractiveSelection(plan, "999")).toThrow(/inválida/);
  });
});

describe("executeCleanPlan — papelera y auditoría", () => {
  it("mueve los safe a la papelera con metadatos completos", async () => {
    const { target } = await fixture();
    const auditPath = await tempAudit();
    const report = await scanProject(target, testRules());
    const plan = await createCleanPlan(report, testRules());
    const result = await executeCleanPlan(plan, testRules(), { auditPath });

    expect(result.action).toBe("trash");
    expect(result.failedCount).toBe(0);
    expect(result.executedCount).toBe(plan.items.length);
    expect(result.freedBytes).toBe(plan.totalBytes);

    // Los originales ya no existen; lo protegido sigue intacto.
    for (const item of plan.items) {
      await expect(fs.stat(item.entry.absolutePath)).rejects.toThrow();
    }
    expect(await fs.stat(path.join(target, ".git"))).toBeTruthy();
    expect(await fs.stat(path.join(target, ".env"))).toBeTruthy();
    expect(await fs.stat(path.join(target, "src"))).toBeTruthy();

    // Sesión de papelera dentro del target, con manifest y items reales.
    expect(result.trashSessionDir).toBeDefined();
    const sessionDir = result.trashSessionDir ?? "";
    expect(sessionDir.startsWith(target + path.sep)).toBe(true);
    expect(sessionDir).toContain(".repo-cleaner-trash");
    const session = JSON.parse(
      await fs.readFile(path.join(sessionDir, "manifest.json"), "utf8")
    ) as TrashSession;
    expect(session.planId).toBe(plan.id);
    expect(session.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(session.items).toHaveLength(plan.items.length);
    for (const meta of session.items) {
      expect(meta.originalPath).toBeTruthy();
      expect(meta.relativePath).toBeTruthy();
      expect(meta.storedPath).toBeTruthy();
      expect(meta.timestamp).toBeTruthy();
      expect(meta.sizeBytes).toBeGreaterThanOrEqual(0);
      expect(meta.risk).toBe("safe");
      expect(meta.action).toBe("trash");
      expect(meta.reason).toBeTruthy();
      expect(meta.planHash).toBe(session.planHash);
      expect(
        await fs.stat(path.join(sessionDir, meta.storedPath))
      ).toBeTruthy();
    }

    // Auditoría: un registro por acción, con el formato exigido.
    const records = await readAudit(auditPath);
    expect(records).toHaveLength(plan.items.length);
    for (const record of records) {
      expect(record.approvedBy).toBe("human");
      expect(record.result).toBe("trashed");
      expect(record.action).toBe("trash");
      expect(record.risk).toBe("safe");
      expect(record.target).toBe(target);
      expect(record.planId).toBe(plan.id);
      expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
    }
  });

  it("el borrado permanente elimina y audita result=deleted", async () => {
    const { target } = await fixture();
    const auditPath = await tempAudit();
    const report = await scanProject(target, testRules());
    const plan = await createCleanPlan(
      report,
      testRules(),
      { only: ["dist"] },
      "permanent"
    );
    const result = await executeCleanPlan(plan, testRules(), { auditPath });

    expect(result.action).toBe("permanent");
    expect(result.executedCount).toBe(1);
    expect(result.trashSessionDir).toBeUndefined();
    await expect(fs.stat(path.join(target, "dist"))).rejects.toThrow();
    const records = await readAudit(auditPath);
    expect(records[0]?.result).toBe("deleted");
    expect(records[0]?.action).toBe("permanent");
  });

  it("un plan forzado contra .git/.env/src/docs/tests falla y no toca nada", async () => {
    const { target } = await fixture();
    const auditPath = await tempAudit();
    const report = await scanProject(target, testRules());
    const protegidas = [".git", ".env", "src", "docs", "tests"];
    const items = protegidas.map((rel) => {
      const entry = report.entries.find((e) => e.relativePath === rel);
      expect(entry).toBeDefined();
      return { entry: entry!, action: "trash" as const, approved: true };
    });
    const forged: CleanPlan = {
      id: "plan-forzado",
      scanReportId: report.id,
      target: report.target,
      projectTypes: report.projectTypes,
      items,
      totalBytes: 0,
      createdAt: new Date().toISOString()
    };
    const result = await executeCleanPlan(forged, testRules(), { auditPath });
    expect(result.failedCount).toBe(protegidas.length);
    expect(result.executedCount).toBe(0);
    for (const rel of protegidas) {
      expect(await fs.stat(path.join(target, rel))).toBeTruthy();
    }
    const records = await readAudit(auditPath);
    expect(records.every((r) => r.result === "failed")).toBe(true);
    expect(records.every((r) => (r.error ?? "").length > 0)).toBe(true);
  });

  it("un review seleccionado explícitamente se mueve a la papelera y se audita", async () => {
    const { target } = await fixture();
    const auditPath = await tempAudit();
    const report = await scanProject(target, testRules());
    const plan = await createCleanPlan(report, testRules(), {
      only: ["datos.bin"]
    });
    const result = await executeCleanPlan(plan, testRules(), { auditPath });
    expect(result.executedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    await expect(fs.stat(path.join(target, "datos.bin"))).rejects.toThrow();
    const records = await readAudit(auditPath);
    expect(records[0]?.result).toBe("trashed");
    expect(records[0]?.risk).toBe("review");
  });

  it("elementos no aprobados se omiten y se auditan como skipped", async () => {
    const { target } = await fixture();
    const auditPath = await tempAudit();
    const report = await scanProject(target, testRules());
    const plan = await createCleanPlan(report, testRules());
    plan.items.forEach((item, index) => {
      item.approved = index === 0;
    });
    const result = await executeCleanPlan(plan, testRules(), { auditPath });
    expect(result.executedCount).toBe(1);
    expect(result.skippedCount).toBe(plan.items.length - 1);
    const records = await readAudit(auditPath);
    expect(records.filter((r) => r.result === "skipped")).toHaveLength(
      plan.items.length - 1
    );
    // Solo desapareció el aprobado; el resto sigue en su sitio.
    const approved = plan.items[0]?.entry;
    expect(approved).toBeDefined();
    await expect(fs.stat(approved?.absolutePath ?? "")).rejects.toThrow();
    for (const item of plan.items.slice(1)) {
      expect(await fs.stat(item.entry.absolutePath)).toBeTruthy();
    }
  });

  it("un elemento que ya no existe se omite sin fallar", async () => {
    const { target } = await fixture();
    const auditPath = await tempAudit();
    const report = await scanProject(target, testRules());
    const plan = await createCleanPlan(report, testRules(), { only: ["dist"] });
    await fs.rm(path.join(target, "dist"), { recursive: true });
    const result = await executeCleanPlan(plan, testRules(), { auditPath });
    expect(result.skippedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    const records = await readAudit(auditPath);
    expect(records[0]?.result).toBe("skipped");
  });
});

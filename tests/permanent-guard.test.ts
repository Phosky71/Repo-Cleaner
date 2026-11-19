import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCleanPlan,
  executeCleanPlan,
  cleanRepository,
  applyInteractiveSelection
} from "../src/core/cleaner.js";
import { scanProject } from "../src/core/scanner.js";
import { readAudit } from "../src/core/audit.js";
import { createServer } from "../src/ui/server.js";
import type { CleanerRuleSet } from "../src/types/index.js";
import { testRules, writeFixtureFile } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
}

/** Proyecto Node con dist/ safe (gitignored) y contenido conocido. */
async function makeFixture(
  extra: Record<string, string> = {}
): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-permaguard-"));
  tempDirs.push(root);
  const target = path.join(root, "proj");
  const aux = path.join(root, "aux");
  await fs.mkdir(aux, { recursive: true });
  await writeFixtureFile(target, "package.json", '{"name":"x"}');
  await writeFixtureFile(target, ".gitignore", "dist/\n");
  await writeFixtureFile(target, "dist/bundle.js", "BUNDLE-CONOCIDO");
  for (const [rel, content] of Object.entries(extra)) {
    await writeFixtureFile(target, rel, content);
  }
  return {
    root,
    target,
    auditPath: path.join(aux, "audit.jsonl"),
    reportsDir: path.join(aux, "reports")
  };
}

const exists = (p: string) =>
  fs
    .stat(p)
    .then(() => true)
    .catch(() => false);

describe("borrado permanente: padre con descendientes protegidos", () => {
  it("padre safe con .env: plan bloqueado, ejecución bloqueada, todo intacto", async () => {
    const f = await makeFixture({ "dist/.env": "SECRET=1" });
    const report = await scanProject(f.target, testRules());
    const plan = await createCleanPlan(
      report,
      testRules(),
      { only: ["dist"] },
      "permanent"
    );
    expect(plan.items[0]?.approved).toBe(false);
    expect(plan.items[0]?.blocked).toMatch(/descendiente protegido/);
    expect(plan.items[0]?.blocked).toMatch(/\.env/);
    expect(plan.totalBytes).toBe(0);

    const result = await executeCleanPlan(plan, testRules(), {
      auditPath: f.auditPath
    });
    expect(result.executedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.items[0]?.result).toBe("skipped");
    expect(result.items[0]?.error).toMatch(/Bloqueado/);
    expect(await exists(path.join(f.target, "dist/.env"))).toBe(true);
    expect(await exists(path.join(f.target, "dist/bundle.js"))).toBe(true);
    // Sin registros falsos de eliminación exitosa.
    const records = await readAudit(f.auditPath);
    expect(records.filter((r) => r.result === "deleted")).toHaveLength(0);
    expect(records.filter((r) => r.result === "skipped")).toHaveLength(1);
  });

  it("descendiente protegido a varios niveles: bloqueado", async () => {
    const f = await makeFixture({ "dist/a/b/c/clave.pem": "CLAVE" });
    const report = await scanProject(f.target, testRules());
    const plan = await createCleanPlan(
      report,
      testRules(),
      { only: ["dist"] },
      "permanent"
    );
    expect(plan.items[0]?.approved).toBe(false);
    expect(plan.items[0]?.blocked).toMatch(/a\/b\/c\/clave\.pem/);
    const result = await executeCleanPlan(plan, testRules(), {
      auditPath: f.auditPath
    });
    expect(result.executedCount).toBe(0);
    expect(await exists(path.join(f.target, "dist/a/b/c/clave.pem"))).toBe(
      true
    );
  });

  it("claves y certificados cubiertos por las reglas existentes: bloqueados", async () => {
    for (const secret of [
      "dist/server.key",
      "dist/cert.pem",
      "dist/almacen.p12"
    ]) {
      const f = await makeFixture({ [secret]: "X" });
      const report = await scanProject(f.target, testRules());
      const plan = await createCleanPlan(
        report,
        testRules(),
        { only: ["dist"] },
        "permanent"
      );
      expect(plan.items[0]?.approved).toBe(false);
      expect(await exists(path.join(f.target, secret))).toBe(true);
    }
  });

  it("reglas debilitadas: las invariantes obligatorias siguen bloqueando", async () => {
    const f = await makeFixture({ "dist/.env": "SECRET=1" });
    const weakened: CleanerRuleSet = {
      ...testRules(),
      protected: [],
      safe: [...testRules().safe, ".env"]
    };
    const report = await scanProject(f.target, weakened);
    const plan = await createCleanPlan(
      report,
      weakened,
      { only: ["dist"] },
      "permanent"
    );
    expect(plan.items[0]?.approved).toBe(false);
    expect(plan.items[0]?.blocked).toMatch(/invariante|protegido/);
    const result = await executeCleanPlan(plan, weakened, {
      auditPath: f.auditPath
    });
    expect(result.executedCount).toBe(0);
    expect(await exists(path.join(f.target, "dist/.env"))).toBe(true);
  });

  it("secreto añadido DESPUÉS de generar el plan: ejecución bloqueada", async () => {
    const f = await makeFixture();
    const report = await scanProject(f.target, testRules());
    const plan = await createCleanPlan(
      report,
      testRules(),
      { only: ["dist"] },
      "permanent"
    );
    expect(plan.items[0]?.approved).toBe(true);
    // Un proceso externo añade un secreto tras generar el plan.
    await writeFixtureFile(f.target, "dist/.env", "SECRET=tardio");
    const result = await executeCleanPlan(plan, testRules(), {
      auditPath: f.auditPath
    });
    expect(result.executedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.items[0]?.error).toMatch(/descendiente protegido/);
    expect(await exists(path.join(f.target, "dist/.env"))).toBe(true);
    expect(await exists(path.join(f.target, "dist/bundle.js"))).toBe(true);
    const records = await readAudit(f.auditPath);
    expect(records.filter((r) => r.result === "deleted")).toHaveLength(0);
  });

  it("inspección incompleta (readdir falla): entrada bloqueada, fail-closed", async () => {
    const f = await makeFixture({ "dist/locked/x.js": "X" });
    const report = await scanProject(f.target, testRules());
    const realReaddir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation((p, o) => {
      if (String(p).includes("locked")) {
        return Promise.reject(
          Object.assign(new Error("EACCES"), { code: "EACCES" })
        );
      }
      return realReaddir(p, o);
    });
    const plan = await createCleanPlan(
      report,
      testRules(),
      { only: ["dist"] },
      "permanent"
    );
    expect(plan.items[0]?.approved).toBe(false);
    expect(plan.items[0]?.blocked).toMatch(/inspección incompleta/);
    const result = await executeCleanPlan(plan, testRules(), {
      auditPath: f.auditPath
    });
    expect(result.executedCount).toBe(0);
    expect(await exists(path.join(f.target, "dist/locked/x.js"))).toBe(true);
    expect(await exists(path.join(f.target, "dist/bundle.js"))).toBe(true);
  });

  it("una entrada bloqueada no puede re-aprobarse por selección interactiva", async () => {
    const f = await makeFixture({ "dist/.env": "SECRET=1" });
    const report = await scanProject(f.target, testRules());
    const plan = await createCleanPlan(
      report,
      testRules(),
      { only: ["dist"] },
      "permanent"
    );
    expect(plan.items[0]?.approved).toBe(false);
    applyInteractiveSelection(plan, "all");
    expect(plan.items[0]?.approved).toBe(false);
    applyInteractiveSelection(plan, "1");
    expect(plan.items[0]?.approved).toBe(false);
    const result = await executeCleanPlan(plan, testRules(), {
      auditPath: f.auditPath
    });
    expect(result.executedCount).toBe(0);
    expect(await exists(path.join(f.target, "dist/.env"))).toBe(true);
  });

  it("padre safe SIN descendientes protegidos: permanent sigue funcionando", async () => {
    const f = await makeFixture();
    const report = await scanProject(f.target, testRules());
    const plan = await createCleanPlan(
      report,
      testRules(),
      { only: ["dist"] },
      "permanent"
    );
    expect(plan.items[0]?.approved).toBe(true);
    expect(plan.items[0]?.blocked).toBeUndefined();
    const result = await executeCleanPlan(plan, testRules(), {
      auditPath: f.auditPath
    });
    expect(result.executedCount).toBe(1);
    expect(result.items[0]?.result).toBe("deleted");
    expect(await exists(path.join(f.target, "dist"))).toBe(false);
    const records = await readAudit(f.auditPath);
    expect(records.filter((r) => r.result === "deleted")).toHaveLength(1);
  });

  it("papelera: comportamiento anterior conservado (reversible, con advertencia)", async () => {
    const f = await makeFixture({ "dist/.env": "SECRET=1" });
    const report = await scanProject(f.target, testRules());
    expect(report.warnings.some((w) => w.includes("dist/.env"))).toBe(true);
    const plan = await createCleanPlan(
      report,
      testRules(),
      { only: ["dist"] },
      "trash"
    );
    expect(plan.items[0]?.approved).toBe(true);
    expect(plan.items[0]?.blocked).toBeUndefined();
    const result = await executeCleanPlan(plan, testRules(), {
      auditPath: f.auditPath
    });
    expect(result.executedCount).toBe(1);
    expect(result.items[0]?.result).toBe("trashed");
    // El .env viaja a la papelera (reversible), no se elimina.
    const sessionDir = result.trashSessionDir ?? "";
    const storedEnv = path.join(sessionDir, "items", "0001-dist", ".env");
    expect(await exists(storedEnv)).toBe(true);
  });
});

describe("misma garantía del core en CLI y API", () => {
  it("API: plan permanente bloqueado y clean no ejecuta", async () => {
    const f = await makeFixture({ "dist/.env": "SECRET=1" });
    const app = createServer({
      allowedRoot: f.root,
      rules: testRules(),
      reportsDir: f.reportsDir,
      auditPath: f.auditPath
    });
    const planRes = await app.request("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: f.target,
        selectedRelativePaths: ["dist"],
        action: "permanent"
      })
    });
    expect(planRes.status).toBe(200);
    const planData = (await planRes.json()) as {
      plan: {
        id: string;
        items: Array<{ approved: boolean; blocked?: string }>;
      };
    };
    expect(planData.plan.items[0]?.approved).toBe(false);
    expect(planData.plan.items[0]?.blocked).toMatch(/descendiente protegido/);
    const cleanRes = await app.request("/api/clean", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planId: planData.plan.id,
        confirmed: true,
        action: "permanent"
      })
    });
    expect(cleanRes.status).toBe(200);
    const cleanData = (await cleanRes.json()) as {
      result: { executedCount: number; skippedCount: number };
    };
    expect(cleanData.result.executedCount).toBe(0);
    expect(cleanData.result.skippedCount).toBe(1);
    expect(await exists(path.join(f.target, "dist/.env"))).toBe(true);
    expect(await exists(path.join(f.target, "dist/bundle.js"))).toBe(true);
  });

  it("CLI: cleanRepository --permanent --yes bloqueado por el mismo core", async () => {
    const f = await makeFixture({ "dist/.env": "SECRET=1" });
    const outcome = await cleanRepository(f.target, testRules(), {
      yes: true,
      permanent: true,
      only: ["dist"],
      isInteractive: false,
      auditPath: f.auditPath,
      reportsDir: f.reportsDir
    });
    // Sin elementos aprobados, cleanRepository no ejecuta nada (result null).
    expect(outcome.result).toBeNull();
    expect(outcome.plan.items[0]?.blocked).toMatch(/descendiente protegido/);
    expect(await exists(path.join(f.target, "dist/.env"))).toBe(true);
    expect(await exists(path.join(f.target, "dist/bundle.js"))).toBe(true);
    const records = await readAudit(f.auditPath);
    expect(records.filter((r) => r.result === "deleted")).toHaveLength(0);
  });
});

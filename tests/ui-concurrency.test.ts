import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createServer } from "../src/ui/server.js";
import { createCleanPlan, executeCleanPlan } from "../src/core/cleaner.js";
import { scanProject } from "../src/core/scanner.js";
import { readAudit } from "../src/core/audit.js";
import { makeFixture, testRules } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  app: Hono;
  root: string;
  target: string;
  auditPath: string;
}

async function makeFixtureApp(): Promise<Fixture> {
  const root = await makeFixture();
  tempDirs.push(root);
  const aux = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-conc-"));
  tempDirs.push(aux);
  const target = path.join(root, "proj-node");
  const auditPath = path.join(aux, "audit.jsonl");
  const app = createServer({
    allowedRoot: root,
    rules: testRules(),
    reportsDir: path.join(aux, "reports"),
    auditPath
  });
  return { app, root, target, auditPath };
}

async function post(
  app: Hono,
  route: string,
  body: unknown
): Promise<Response> {
  return await app.request(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function createCleanPlanViaApi(fixture: Fixture): Promise<string> {
  const response = await post(fixture.app, "/api/plan", {
    projectPath: fixture.target,
    selectedRelativePaths: ["node_modules", "dist", "debug.log"],
    action: "trash"
  });
  expect(response.status).toBe(200);
  const data = (await response.json()) as { plan: { id: string } };
  return data.plan.id;
}

describe("generar plan no tiene efectos destructivos (servidor)", () => {
  it("plan generado: archivos intactos, sin papelera ni auditoría; confirmar ejecuta una vez", async () => {
    const fixture = await makeFixtureApp();
    const planId = await createCleanPlanViaApi(fixture);
    // Tras generar el plan: nada se movió, nada se auditó.
    for (const rel of ["node_modules", "dist", "debug.log"]) {
      expect(await fs.stat(path.join(fixture.target, rel))).toBeTruthy();
    }
    await expect(
      fs.stat(path.join(fixture.target, ".repo-cleaner-trash"))
    ).rejects.toThrow();
    expect(await readAudit(fixture.auditPath)).toEqual([]);
    // Esperar sin confirmar mantiene las garantías.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readAudit(fixture.auditPath)).toEqual([]);
    // Confirmación explícita posterior: exactamente una ejecución.
    const response = await post(fixture.app, "/api/clean", {
      planId,
      confirmed: true,
      action: "trash"
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      result: {
        executedCount: number;
        items: Array<{ entry: { relativePath: string } }>;
      };
    };
    expect(data.result.executedCount).toBe(3);
    expect(data.result.items.map((i) => i.entry.relativePath).sort()).toEqual([
      "debug.log",
      "dist",
      "node_modules"
    ]);
    const records = await readAudit(fixture.auditPath);
    expect(records.filter((r) => r.result === "trashed")).toHaveLength(3);
  });
});

describe("consumo único de planes bajo concurrencia", () => {
  it("clean: 10 solicitudes simultáneas -> exactamente 1 ejecución y 1 auditoría", async () => {
    const fixture = await makeFixtureApp();
    const planId = await createCleanPlanViaApi(fixture);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        post(fixture.app, "/api/clean", {
          planId,
          confirmed: true,
          action: "trash"
        })
      )
    );
    const executed = responses.filter((r) => r.status === 200);
    const rejected = responses.filter(
      (r) => r.status === 409 || r.status === 404
    );
    expect(executed).toHaveLength(1);
    expect(rejected).toHaveLength(9);

    // Sin doble ejecución destructiva: los originales se movieron una vez.
    for (const rel of ["node_modules", "dist", "debug.log"]) {
      await expect(fs.stat(path.join(fixture.target, rel))).rejects.toThrow();
    }

    // Auditoría: una sola ejecución real (3 trashed, sin duplicados).
    const records = await readAudit(fixture.auditPath);
    const ofPlan = records.filter((r) => r.planId === planId);
    expect(ofPlan.filter((r) => r.result === "trashed")).toHaveLength(3);
    expect(ofPlan.filter((r) => r.result === "skipped")).toHaveLength(0);
    expect(ofPlan.filter((r) => r.result === "failed")).toHaveLength(0);

    // El plan no puede reutilizarse después.
    const replay = await post(fixture.app, "/api/clean", {
      planId,
      confirmed: true,
      action: "trash"
    });
    expect(replay.status).toBe(404);
  });

  it("restore: 10 solicitudes simultáneas -> exactamente 1 ejecución y 1 auditoría", async () => {
    const fixture = await makeFixtureApp();
    // Preparar papelera mediante el núcleo (una sola limpieza previa).
    const report = await scanProject(fixture.target, testRules());
    const cleanPlan = await createCleanPlan(report, testRules());
    const cleanResult = await executeCleanPlan(cleanPlan, testRules(), {
      auditPath: fixture.auditPath
    });
    const sessionId = path.basename(cleanResult.trashSessionDir ?? "");

    const planResponse = await post(fixture.app, "/api/restore/plan", {
      projectPath: fixture.target,
      sessionId,
      selectedRelativePaths: ["node_modules", "dist", "debug.log"]
    });
    expect(planResponse.status).toBe(200);
    const planId = ((await planResponse.json()) as { plan: { id: string } })
      .plan.id;

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        post(fixture.app, "/api/restore/execute", { planId, confirmed: true })
      )
    );
    const executed = responses.filter((r) => r.status === 200);
    const rejected = responses.filter(
      (r) => r.status === 409 || r.status === 404
    );
    expect(executed).toHaveLength(1);
    expect(rejected).toHaveLength(9);

    // Restaurado una sola vez.
    for (const rel of ["node_modules", "dist", "debug.log"]) {
      expect(await fs.stat(path.join(fixture.target, rel))).toBeTruthy();
    }
    const records = await readAudit(fixture.auditPath);
    const restores = records.filter(
      (r) => r.action === "restore" && r.planId === cleanPlan.id
    );
    expect(restores.filter((r) => r.result === "restored")).toHaveLength(3);
    expect(restores.filter((r) => r.result === "skipped")).toHaveLength(0);

    const replay = await post(fixture.app, "/api/restore/execute", {
      planId,
      confirmed: true
    });
    expect(replay.status).toBe(404);
  });

  it("un rechazo de validación secuencial conserva el plan (sin consumo)", async () => {
    const fixture = await makeFixtureApp();
    const planId = await createCleanPlanViaApi(fixture);
    const mismatch = await post(fixture.app, "/api/clean", {
      planId,
      confirmed: true,
      action: "permanent"
    });
    expect(mismatch.status).toBe(400);
    // El plan sigue vivo tras el rechazo.
    const ok = await post(fixture.app, "/api/clean", {
      planId,
      confirmed: true,
      action: "trash"
    });
    expect(ok.status).toBe(200);
  });
});

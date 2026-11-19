import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createServer } from "../src/ui/server.js";
import { createCleanPlan, executeCleanPlan } from "../src/core/cleaner.js";
import { scanProject } from "../src/core/scanner.js";
import { readAudit } from "../src/core/audit.js";
import type { RestoreResult, TrashSessionInfo } from "../src/types/index.js";
import { makeFixture, testRules, writeFixtureFile } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

interface UiFixture {
  app: Hono;
  root: string;
  target: string;
  auditPath: string;
  sessionId: string;
}

async function makeUiFixture(planTtlMs = 60000): Promise<UiFixture> {
  const root = await makeFixture();
  tempDirs.push(root);
  const aux = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-ui-rest-"));
  tempDirs.push(aux);
  const target = path.join(root, "proj-node");
  const auditPath = path.join(aux, "audit.jsonl");
  const reportsDir = path.join(aux, "reports");

  const report = await scanProject(target, testRules());
  const plan = await createCleanPlan(report, testRules());
  const result = await executeCleanPlan(plan, testRules(), { auditPath });
  const sessionId = path.basename(result.trashSessionDir ?? "");

  const app = createServer({
    allowedRoot: root,
    rules: testRules(),
    reportsDir,
    auditPath,
    planTtlMs
  });
  return { app, root, target, auditPath, sessionId };
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

const enc = encodeURIComponent;

describe("GET /api/trash", () => {
  it("lista las sesiones del proyecto", async () => {
    const { app, target, sessionId } = await makeUiFixture();
    const response = await app.request(`/api/trash/${enc(target)}`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { sessions: TrashSessionInfo[] };
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]?.sessionId).toBe(sessionId);
    expect(data.sessions[0]?.status).toBe("restorable");
  });

  it("devuelve el detalle de una sesión con estados", async () => {
    const { app, target, sessionId } = await makeUiFixture();
    const response = await app.request(
      `/api/trash/${enc(target)}/${enc(sessionId)}`
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      session: { items: unknown[] };
      items: Array<{ storedExists: boolean; conflict: boolean }>;
    };
    expect(data.session.items).toHaveLength(3);
    expect(data.items.every((item) => item.storedExists)).toBe(true);
    expect(data.items.every((item) => !item.conflict)).toBe(true);
  });

  it("rechaza proyectos fuera de la raíz, con .. y sesiones inválidas", async () => {
    const { app, target, root, sessionId } = await makeUiFixture();
    const outside = await app.request(`/api/trash/${enc(os.tmpdir())}`);
    expect(outside.status).toBe(400);
    const escape = await app.request(
      `/api/trash/${enc(`${root}${path.sep}..`)}`
    );
    expect(escape.status).toBe(400);
    const badId = await app.request(`/api/trash/${enc(target)}/bad_id`);
    expect(badId.status).toBe(400);
    const unknown = await app.request(
      `/api/trash/${enc(target)}/19990101-000000`
    );
    expect(unknown.status).toBe(404);
    expect(sessionId).toBeTruthy();
  });
});

describe("POST /api/restore/plan", () => {
  it("genera un plan de restauración con hash", async () => {
    const { app, target, sessionId } = await makeUiFixture();
    const response = await post(app, "/api/restore/plan", {
      projectPath: target,
      sessionId,
      selectedRelativePaths: ["dist", "node_modules"]
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      plan: { items: unknown[]; id: string };
      planHash: string;
    };
    expect(data.plan.items).toHaveLength(2);
    expect(data.planHash).toMatch(/^[0-9a-f]{64}$/);
    // Nada restaurado todavía.
    await expect(fs.stat(path.join(target, "dist"))).rejects.toThrow();
  });

  it("rechaza rutas desconocidas, selección vacía y onConflict inválido", async () => {
    const { app, target, sessionId } = await makeUiFixture();
    const unknown = await post(app, "/api/restore/plan", {
      projectPath: target,
      sessionId,
      selectedRelativePaths: ["fantasma"]
    });
    expect(unknown.status).toBe(400);
    const empty = await post(app, "/api/restore/plan", {
      projectPath: target,
      sessionId,
      selectedRelativePaths: []
    });
    expect(empty.status).toBe(400);
    const badMode = await post(app, "/api/restore/plan", {
      projectPath: target,
      sessionId,
      selectedRelativePaths: ["dist"],
      onConflict: "destroy"
    });
    expect(badMode.status).toBe(400);
  });

  it("rechaza proyectos fuera de la raíz o con ..", async () => {
    const { app, root, sessionId } = await makeUiFixture();
    const outside = await post(app, "/api/restore/plan", {
      projectPath: os.tmpdir(),
      sessionId,
      selectedRelativePaths: ["dist"]
    });
    expect(outside.status).toBe(400);
    const escape = await post(app, "/api/restore/plan", {
      projectPath: `${root}${path.sep}proj-node${path.sep}..${path.sep}..`,
      sessionId,
      selectedRelativePaths: ["dist"]
    });
    expect(escape.status).toBe(400);
  });
});

describe("POST /api/restore/execute", () => {
  async function makeRestorePlan(
    fixture: UiFixture,
    selected: string[],
    onConflict?: string
  ): Promise<string> {
    const response = await post(fixture.app, "/api/restore/plan", {
      projectPath: fixture.target,
      sessionId: fixture.sessionId,
      selectedRelativePaths: selected,
      ...(onConflict ? { onConflict } : {})
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { plan: { id: string } };
    return data.plan.id;
  }

  it("rechaza sin confirmación explícita", async () => {
    const fixture = await makeUiFixture();
    const planId = await makeRestorePlan(fixture, ["dist"]);
    for (const confirmed of [false, "true", undefined]) {
      const response = await post(fixture.app, "/api/restore/execute", {
        planId,
        confirmed
      });
      expect(response.status).toBe(400);
    }
    await expect(fs.stat(path.join(fixture.target, "dist"))).rejects.toThrow();
  });

  it("rechaza planes inexistentes o expirados", async () => {
    const fixture = await makeUiFixture();
    const missing = await post(fixture.app, "/api/restore/execute", {
      planId: "00000000-0000-0000-0000-000000000000",
      confirmed: true
    });
    expect(missing.status).toBe(404);

    const expired = await makeUiFixture(0);
    const planId = await makeRestorePlan(expired, ["dist"]);
    const response = await post(expired.app, "/api/restore/execute", {
      planId,
      confirmed: true
    });
    expect(response.status).toBe(410);
  });

  it("restaura con papelera inversa, audita y expone informe por ID", async () => {
    const fixture = await makeUiFixture();
    const planId = await makeRestorePlan(fixture, ["dist", "node_modules"]);
    const response = await post(fixture.app, "/api/restore/execute", {
      planId,
      confirmed: true
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      result: RestoreResult;
      reportId: string;
    };
    expect(data.result.restoredCount).toBe(2);
    expect(await fs.stat(path.join(fixture.target, "dist"))).toBeTruthy();
    expect(
      await fs.stat(path.join(fixture.target, "node_modules"))
    ).toBeTruthy();

    const records = await readAudit(fixture.auditPath);
    const restores = records.filter((r) => r.action === "restore");
    expect(restores).toHaveLength(2);
    expect(restores.every((r) => r.result === "restored")).toBe(true);
    expect(restores.every((r) => r.sessionId === fixture.sessionId)).toBe(true);

    const reportResponse = await fixture.app.request(
      `/api/report/${data.reportId}`
    );
    expect(reportResponse.status).toBe(200);
    const stored = (await reportResponse.json()) as RestoreResult;
    expect(stored.id).toBe(data.result.id);

    // Replay rechazado.
    const replay = await post(fixture.app, "/api/restore/execute", {
      planId,
      confirmed: true
    });
    expect(replay.status).toBe(404);
  });

  it("overwrite exige confirmación adicional explícita", async () => {
    const fixture = await makeUiFixture();
    await writeFixtureFile(fixture.target, "dist/nuevo.js", "nuevo");
    const planId = await makeRestorePlan(fixture, ["dist"], "overwrite");

    const withoutExtra = await post(fixture.app, "/api/restore/execute", {
      planId,
      confirmed: true
    });
    expect(withoutExtra.status).toBe(400);
    expect(
      await fs.readFile(path.join(fixture.target, "dist/nuevo.js"), "utf8")
    ).toBe("nuevo");

    // El plan sigue vivo tras el rechazo: ahora con confirmación adicional.
    const withExtra = await post(fixture.app, "/api/restore/execute", {
      planId,
      confirmed: true,
      overwriteConfirmed: true
    });
    expect(withExtra.status).toBe(200);
    const data = (await withExtra.json()) as { result: RestoreResult };
    expect(data.result.restoredCount).toBe(1);
    await expect(
      fs.stat(path.join(fixture.target, "dist/nuevo.js"))
    ).rejects.toThrow();
  });
});

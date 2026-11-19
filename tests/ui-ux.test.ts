import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createServer } from "../src/ui/server.js";
import { createCleanPlan, executeCleanPlan } from "../src/core/cleaner.js";
import {
  createRestorePlan,
  executeRestorePlan,
  readTrashSession
} from "../src/core/restore.js";
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

interface UxFixture {
  app: Hono;
  root: string;
  target: string;
  auditPath: string;
  sessionId: string;
}

async function makeUxFixture(restored: boolean): Promise<UxFixture> {
  const root = await makeFixture();
  tempDirs.push(root);
  const aux = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-ux-"));
  tempDirs.push(aux);
  const target = path.join(root, "proj-node");
  const auditPath = path.join(aux, "audit.jsonl");
  const report = await scanProject(target, testRules());
  const plan = createCleanPlan(report);
  const result = await executeCleanPlan(plan, testRules(), { auditPath });
  const sessionId = path.basename(result.trashSessionDir ?? "");
  if (restored) {
    const session = await readTrashSession(target, sessionId);
    const restorePlan = await createRestorePlan(target, session, {
      all: true
    });
    await executeRestorePlan(restorePlan, testRules(), { auditPath });
  }
  const app = createServer({
    allowedRoot: root,
    rules: testRules(),
    reportsDir: path.join(aux, "reports"),
    auditPath
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

describe("UX — estados vacíos y accesibilidad en el HTML", () => {
  it("incluye estados vacíos explicativos para todas las vistas", async () => {
    const { app } = await makeUxFixture(false);
    const html = await (await app.request("/")).text();
    for (const id of [
      "projects-empty",
      "inspect-empty",
      "artifacts-empty",
      "reports-empty"
    ]) {
      expect(html).toContain(id);
    }
    expect(html).toContain("No se han detectado proyectos");
    expect(html).toContain("no contiene artefactos");
    expect(html).toContain("No hay informes históricos todavía");
    // Accesibilidad básica: label oculto y roles de estado.
    expect(html).toContain('for="root-path"');
    expect(html).toContain("sr-only");
    expect(html).toContain('role="alert"');
  });

  it("el JS gestiona estados vacíos, progreso y guardas anti-duplicados", async () => {
    const { app } = await makeUxFixture(false);
    const js = await (await app.request("/app.js")).text();
    expect(js).toContain("projects-empty");
    expect(js).toContain("artifacts-empty");
    expect(js).toContain("async function guarded");
    expect(js).toContain("if (state.busy) return");
    expect(js).toContain("aria-busy");
    expect(js).toContain("Error de red");
    expect(js).toContain("No hay sesiones de papelera");
    // Restauración del estado tras error (finally rehabilita botones).
    expect(js).toMatch(/finally\s*\{[^}]*disabled = false/s);
    // Sin innerHTML: todo el contenido dinámico usa textContent.
    expect(js).not.toContain("innerHTML");
    expect(js).toContain("textContent");
  });

  it("mantiene CSP estricta", async () => {
    const { app } = await makeUxFixture(false);
    const response = await app.request("/");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });
});

describe("UX — mensajes de error accionables", () => {
  it("ruta fuera del target, .., inexistente y archivo explican qué hacer", async () => {
    const { app, root, target } = await makeUxFixture(false);
    const outside = await post(app, "/api/inspect", {
      projectPath: os.tmpdir()
    });
    expect(outside.status).toBe(400);
    expect(((await outside.json()) as { error: string }).error).toMatch(
      /Vuelve a seleccionar/
    );

    const escape = await post(app, "/api/inspect", {
      projectPath: `${root}${path.sep}..`
    });
    expect(((await escape.json()) as { error: string }).error).toMatch(
      /segmentos de escape/
    );

    const missing = await post(app, "/api/inspect", {
      projectPath: path.join(root, "fantasma")
    });
    expect(((await missing.json()) as { error: string }).error).toMatch(
      /Comprueba que esté bien escrita/
    );

    const file = await post(app, "/api/inspect", {
      projectPath: path.join(target, "package.json")
    });
    expect(((await file.json()) as { error: string }).error).toMatch(
      /Selecciona una carpeta/
    );
  });

  it("plan expirado y confirmación ausente guían al usuario", async () => {
    const { app, target, sessionId } = await makeUxFixture(false);
    const planResponse = await post(app, "/api/restore/plan", {
      projectPath: target,
      sessionId,
      selectedRelativePaths: ["dist"]
    });
    expect(planResponse.status).toBe(200);
    const planId = ((await planResponse.json()) as { plan: { id: string } })
      .plan.id;

    const noConfirm = await post(app, "/api/restore/execute", {
      planId,
      confirmed: false
    });
    expect(noConfirm.status).toBe(400);
    expect(((await noConfirm.json()) as { error: string }).error).toMatch(
      /Confirma la acción/
    );

    // Plan expirado: servidor con TTL 0.
    const root = await makeFixture();
    tempDirs.push(root);
    const expiredApp = createServer({
      allowedRoot: root,
      rules: testRules(),
      planTtlMs: 0
    });
    const expiredPlan = await post(expiredApp, "/api/plan", {
      projectPath: path.join(root, "proj-node"),
      selectedRelativePaths: ["dist"]
    });
    const expiredId = ((await expiredPlan.json()) as { plan: { id: string } })
      .plan.id;
    const expired = await post(expiredApp, "/api/clean", {
      planId: expiredId,
      confirmed: true
    });
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as { error: string }).error).toMatch(
      /Genera un plan nuevo/
    );
  });

  it("informe inexistente sugiere actualizar el listado", async () => {
    const { app } = await makeUxFixture(false);
    const response = await app.request(
      "/api/reports/00000000-0000-0000-0000-000000000000"
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /Actualiza el listado/
    );
  });
});

describe("UX — confirmaciones destructivas", () => {
  it("papelera: nota de reversibilidad; permanente: palabra y aviso rojo", async () => {
    const { app } = await makeUxFixture(false);
    const html = await (await app.request("/")).text();
    expect(html).toContain("permanent-confirm");
    expect(html).toContain("PERMANENTE");
    expect(html).toContain("warning-danger");
    expect(html).toContain("plan-action-note");
    const js = await (await app.request("/app.js")).text();
    expect(js).toContain("Es reversible");
    expect(js).toContain("eliminación permanente e irreversible");
    expect(js).toContain('=== "PERMANENTE"');
  });

  it("sobrescritura: lista de rutas afectadas y palabra OVERWRITE", async () => {
    const { app } = await makeUxFixture(false);
    const html = await (await app.request("/")).text();
    expect(html).toContain("restore-overwrite-list");
    expect(html).toContain("OVERWRITE");
    const js = await (await app.request("/app.js")).text();
    expect(js).toContain("será reemplazado");
    expect(js).toContain('=== "OVERWRITE"');
  });

  it("purga de sesiones: panel con tamaños y nota de auditoría conservada", async () => {
    const { app } = await makeUxFixture(false);
    const html = await (await app.request("/")).text();
    expect(html).toContain("purge-confirm");
    expect(html).toContain("purge-summary");
    expect(html).toContain("El registro de auditoría se conserva");
    expect(html).toContain("btn-purge-execute");
  });
});

describe("UX — endpoint de purga con confirmación", () => {
  it("rechaza sin confirmación explícita", async () => {
    const { app, target } = await makeUxFixture(true);
    const response = await post(app, "/api/trash/purge", {
      projectPath: target,
      confirmed: false
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /auditoría se conserva/
    );
  });

  it("purga sesiones completadas y conserva la auditoría", async () => {
    const { app, target, auditPath, sessionId } = await makeUxFixture(true);
    const response = await post(app, "/api/trash/purge", {
      projectPath: target,
      confirmed: true
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      purged: Array<{ result: string }>;
      freedBytes: number;
    };
    expect(data.purged[0]?.result).toBe("purged");
    expect(data.freedBytes).toBeGreaterThan(0);
    const sessionDir = path.join(target, ".repo-cleaner-trash", sessionId);
    await expect(fs.stat(sessionDir)).rejects.toThrow();
    const records = await readAudit(auditPath);
    expect(records.some((r) => r.action === "purge")).toBe(true);
  });

  it("nunca purga sesiones con elementos pendientes", async () => {
    const { app, target, sessionId } = await makeUxFixture(false);
    const response = await post(app, "/api/trash/purge", {
      projectPath: target,
      confirmed: true
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      purged: unknown[];
      kept: string[];
    };
    expect(data.purged).toEqual([]);
    expect(data.kept).toContain(sessionId);
    const sessionDir = path.join(target, ".repo-cleaner-trash", sessionId);
    expect(await fs.stat(sessionDir)).toBeTruthy();
  });

  it("rechaza proyectos fuera de la raíz autorizada", async () => {
    const { app } = await makeUxFixture(false);
    const response = await post(app, "/api/trash/purge", {
      projectPath: os.tmpdir(),
      confirmed: true
    });
    expect(response.status).toBe(400);
  });
});

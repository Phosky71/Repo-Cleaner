import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createServer } from "../src/ui/server.js";
import { inspectRepository } from "../src/core/inspect.js";
import { scanProject } from "../src/core/scanner.js";
import { createCleanPlan, executeCleanPlan } from "../src/core/cleaner.js";
import {
  createRestorePlan,
  executeRestorePlan,
  readTrashSession
} from "../src/core/restore.js";
import { saveCleanResult, saveRestoreResult } from "../src/core/report.js";
import { makeFixture, testRules } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

interface ReportsFixture {
  app: Hono;
  root: string;
  inspectId: string;
  cleanId: string;
  restoreId: string;
}

/** Genera informes reales (inspect, clean, restore) en un dir aislado. */
async function makeReportsFixture(): Promise<ReportsFixture> {
  const root = await makeFixture();
  tempDirs.push(root);
  const aux = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-reports-"));
  tempDirs.push(aux);
  const reportsDir = path.join(aux, "reports");
  const auditPath = path.join(aux, "audit.jsonl");
  const target = path.join(root, "proj-node");

  const { report: inspectReport } = await inspectRepository(
    target,
    testRules(),
    {
      reportsDir
    }
  );

  const scan = await scanProject(target, testRules());
  const plan = createCleanPlan(scan);
  const cleanResult = await executeCleanPlan(plan, testRules(), { auditPath });
  await saveCleanResult(cleanResult, scan, reportsDir);

  const session = await readTrashSession(
    target,
    path.basename(cleanResult.trashSessionDir ?? "")
  );
  const restorePlan = await createRestorePlan(target, session, { all: true });
  const restoreResult = await executeRestorePlan(restorePlan, testRules(), {
    auditPath
  });
  await saveRestoreResult(restoreResult, reportsDir);

  const app = createServer({
    allowedRoot: root,
    rules: testRules(),
    reportsDir,
    auditPath
  });
  return {
    app,
    root,
    inspectId: inspectReport.id,
    cleanId: cleanResult.id,
    restoreId: restoreResult.id
  };
}

interface ReportListItem {
  id: string;
  kind: string;
  filename: string;
  generatedAt: string;
  target: string;
  summary: string;
  status: string;
}

describe("GET /api/reports — listado histórico", () => {
  it("lista informes reales ordenados por fecha con tipo y resumen", async () => {
    const { app } = await makeReportsFixture();
    const response = await app.request("/api/reports");
    expect(response.status).toBe(200);
    const data = (await response.json()) as { reports: ReportListItem[] };
    expect(data.reports.length).toBeGreaterThanOrEqual(3);
    const kinds = data.reports.map((r) => r.kind);
    expect(kinds).toContain("inspect");
    expect(kinds).toContain("clean");
    expect(kinds).toContain("restore");
    for (const item of data.reports) {
      expect(item.id).toBeTruthy();
      expect(item.filename.endsWith(".json")).toBe(true);
      expect(item.summary).toBeTruthy();
      expect(item.status).toBeTruthy();
    }
    const dates = data.reports.map((r) => r.generatedAt);
    const sorted = [...dates].sort((a, b) => b.localeCompare(a));
    expect(dates).toEqual(sorted);
  });

  it("directorio de informes vacío: lista vacía sin error", async () => {
    const root = await makeFixture();
    tempDirs.push(root);
    const empty = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-cleaner-empty-")
    );
    tempDirs.push(empty);
    const app = createServer({
      allowedRoot: root,
      rules: testRules(),
      reportsDir: empty
    });
    const response = await app.request("/api/reports");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reports: [] });
  });
});

describe("GET /api/reports/:id — detalle y descarga", () => {
  it("devuelve el JSON del informe con Content-Type correcto", async () => {
    const { app, inspectId } = await makeReportsFixture();
    const response = await app.request(`/api/reports/${inspectId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const parsed = (await response.json()) as { id: string };
    expect(parsed.id).toBe(inspectId);
  });

  it("descarga JSON como attachment", async () => {
    const { app, cleanId } = await makeReportsFixture();
    const response = await app.request(
      `/api/reports/${cleanId}/download?format=json`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toMatch(/attachment/);
    const parsed = (await response.json()) as { clean: { id: string } };
    expect(parsed.clean.id).toBe(cleanId);
  });

  it("descarga Markdown como text/markdown", async () => {
    const { app, restoreId } = await makeReportsFixture();
    const response = await app.request(
      `/api/reports/${restoreId}/download?format=md`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("content-disposition")).toMatch(/attachment/);
    expect(await response.text()).toContain("# Informe de restauración");
  });

  it("rechaza IDs inválidos, .. y rutas absolutas", async () => {
    const { app } = await makeReportsFixture();
    expect((await app.request("/api/reports/bad_id")).status).toBe(400);
    // El router resuelve ".." antes del handler: 400 o 404, nunca ficheros.
    expect([400, 404]).toContain(
      (await app.request("/api/reports/%2e%2e")).status
    );
    expect(
      (await app.request("/api/reports/C:%5CWindows%5Cevil.json")).status
    ).toBe(400);
    expect(
      (await app.request("/api/reports/bad_id/download?format=json")).status
    ).toBe(400);
  });

  it("rechaza informes inexistentes", async () => {
    const { app } = await makeReportsFixture();
    const unknown = "00000000-0000-0000-0000-000000000000";
    expect((await app.request(`/api/reports/${unknown}`)).status).toBe(404);
    expect(
      (await app.request(`/api/reports/${unknown}/download?format=md`)).status
    ).toBe(404);
  });

  it("rechaza formatos inválidos", async () => {
    const { app, inspectId } = await makeReportsFixture();
    const response = await app.request(
      `/api/reports/${inspectId}/download?format=exe`
    );
    expect(response.status).toBe(400);
  });

  it("los informes son de solo lectura: sin DELETE ni PUT", async () => {
    const { app, inspectId } = await makeReportsFixture();
    const del = await app.request(`/api/reports/${inspectId}`, {
      method: "DELETE"
    });
    expect(del.status).toBe(404);
    const put = await app.request(`/api/reports/${inspectId}`, {
      method: "PUT",
      body: "{}"
    });
    expect(put.status).toBe(404);
    // El informe sigue accesible tras los intentos.
    expect((await app.request(`/api/reports/${inspectId}`)).status).toBe(200);
  });
});

describe("informes históricos — seguridad y UI", () => {
  it("rechaza Host y Origin no locales", async () => {
    const { app } = await makeReportsFixture();
    const host = await app.request("/api/reports", {
      headers: { Host: "evil.example.com" }
    });
    expect(host.status).toBe(403);
    const origin = await app.request("/api/reports", {
      headers: { Origin: "http://evil.example.com" }
    });
    expect(origin.status).toBe(403);
  });

  it("la UI incluye navegación y vista de informes", async () => {
    const { app } = await makeReportsFixture();
    const home = await app.request("/");
    const html = await home.text();
    expect(html).toContain("btn-open-reports");
    expect(html).toContain("view-reports");
    expect(html).toContain("report-detail-content");
    const js = await (await app.request("/app.js")).text();
    expect(js).toContain("openReports");
    expect(js).toContain("/api/reports");
    expect(js).toContain("textContent");
    expect(home.headers.get("content-security-policy")).toContain(
      "default-src 'self'"
    );
  });
});

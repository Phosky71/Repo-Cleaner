import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createServer } from "../src/ui/server.js";
import { readAudit } from "../src/core/audit.js";
import type { CleanResult, ScanReport } from "../src/types/index.js";
import { makeFixture, testRules } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

interface TestContext {
  app: Hono;
  root: string;
  target: string;
  auditPath: string;
  reportsDir: string;
}

async function makeContext(planTtlMs = 60000): Promise<TestContext> {
  const root = await makeFixture();
  tempDirs.push(root);
  const aux = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-ui-"));
  tempDirs.push(aux);
  const auditPath = path.join(aux, "clean-audit.jsonl");
  const reportsDir = path.join(aux, "reports");
  const app = createServer({
    allowedRoot: root,
    rules: testRules(),
    rulesSource: "test",
    reportsDir,
    auditPath,
    planTtlMs
  });
  return {
    app,
    root,
    target: path.join(root, "proj-node"),
    auditPath,
    reportsDir
  };
}

async function post(
  app: Hono,
  route: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return await app.request(route, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("GET /api/health y frontend", () => {
  it("health devuelve status ok", async () => {
    const { app } = await makeContext();
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("sirve la UI con CSP y la raíz autorizada inyectada", async () => {
    const { app, root } = await makeContext();
    const response = await app.request("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Repo Cleaner");
    expect(html).not.toContain("__ALLOWED_ROOT__");
    expect(html).toContain(root);
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'"
    );
    expect((await app.request("/app.js")).status).toBe(200);
    expect((await app.request("/styles.css")).status).toBe(200);
  });

  it("rechaza Host y Origin no locales (anti DNS-rebinding/CSRF)", async () => {
    const { app } = await makeContext();
    const hostResponse = await app.request("/api/health", {
      headers: { Host: "evil.example.com" }
    });
    expect(hostResponse.status).toBe(403);
    const originResponse = await post(
      app,
      "/api/scan",
      { rootPath: "C:/Trabajo" },
      { Origin: "http://evil.example.com" }
    );
    expect(originResponse.status).toBe(403);
  });
});

describe("POST /api/scan — validación de rutas", () => {
  it("escanea la raíz autorizada y devuelve proyectos sin entradas pesadas", async () => {
    const { app, root } = await makeContext();
    const response = await post(app, "/api/scan", { rootPath: root });
    expect(response.status).toBe(200);
    const data = await jsonOf(response);
    expect(data.reportId).toBeTruthy();
    const projects = data.projects as Array<Record<string, unknown>>;
    expect(projects).toHaveLength(3);
    expect(projects[0]?.entries).toBeUndefined();
    expect(projects[0]?.artifacts).toBeTruthy();
  });

  it("rechaza rutas fuera de la raíz autorizada", async () => {
    const { app } = await makeContext();
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-cleaner-out-")
    );
    tempDirs.push(outside);
    const response = await post(app, "/api/scan", { rootPath: outside });
    expect(response.status).toBe(400);
    expect((await jsonOf(response)).error).toMatch(/fuera de la raíz/);
  });

  it("rechaza rutas con ..", async () => {
    const { app, root } = await makeContext();
    const response = await post(app, "/api/scan", {
      rootPath: `${root}${path.sep}..`
    });
    expect(response.status).toBe(400);
    expect((await jsonOf(response)).error).toMatch(/\.\./);
  });

  it("rechaza rutas inexistentes o que no son directorios", async () => {
    const { app, root, target } = await makeContext();
    const missing = await post(app, "/api/scan", {
      rootPath: path.join(root, "fantasma")
    });
    expect(missing.status).toBe(400);
    const file = await post(app, "/api/scan", {
      rootPath: path.join(target, "package.json")
    });
    expect(file.status).toBe(400);
    expect((await jsonOf(file)).error).toMatch(/no es un directorio/);
  });
});

describe("POST /api/inspect", () => {
  it("devuelve artefactos clasificados con regla y motivo + reportId", async () => {
    const { app, target } = await makeContext();
    const response = await post(app, "/api/inspect", { projectPath: target });
    expect(response.status).toBe(200);
    const report = (await response.json()) as ScanReport & { reportId: string };
    expect(report.reportId).toBe(report.id);
    expect(report.projectTypes).toEqual(["typescript", "nodejs"]);
    const nodeModules = report.entries.find(
      (e) => e.relativePath === "node_modules"
    );
    expect(nodeModules?.risk).toBe("safe");
    expect(nodeModules?.matchedRule).toBe("node_modules");
    expect(nodeModules?.reason).toBeTruthy();
  });

  it("rechaza proyectos fuera de la raíz o con ..", async () => {
    const { app, root } = await makeContext();
    const outside = await post(app, "/api/inspect", {
      projectPath: os.tmpdir()
    });
    expect(outside.status).toBe(400);
    const escape = await post(app, "/api/inspect", {
      projectPath: `${root}${path.sep}proj-node${path.sep}..${path.sep}..`
    });
    expect(escape.status).toBe(400);
  });
});

describe("POST /api/plan", () => {
  it("genera un plan con hash sin eliminar nada", async () => {
    const { app, target } = await makeContext();
    const response = await post(app, "/api/plan", {
      projectPath: target,
      selectedRelativePaths: ["node_modules", "dist"],
      action: "trash"
    });
    expect(response.status).toBe(200);
    const data = await jsonOf(response);
    const plan = data.plan as { items: unknown[]; id: string };
    expect(plan.items).toHaveLength(2);
    expect(data.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.expiresAt).toBeTruthy();
    // Nada se ha movido todavía.
    expect(await fs.stat(path.join(target, "node_modules"))).toBeTruthy();
  });

  it("rechaza rutas protegidas, desconocidas, con .. y absolutas", async () => {
    const { app, target } = await makeContext();
    const protectedResponse = await post(app, "/api/plan", {
      projectPath: target,
      selectedRelativePaths: [".git"],
      action: "trash"
    });
    expect(protectedResponse.status).toBe(400);
    expect((await jsonOf(protectedResponse)).error).toMatch(/protegido/);

    const unknown = await post(app, "/api/plan", {
      projectPath: target,
      selectedRelativePaths: ["fantasma"],
      action: "trash"
    });
    expect(unknown.status).toBe(400);

    const escape = await post(app, "/api/plan", {
      projectPath: target,
      selectedRelativePaths: ["../fuera"],
      action: "trash"
    });
    expect(escape.status).toBe(400);

    const absolute = await post(app, "/api/plan", {
      projectPath: target,
      selectedRelativePaths: ["C:/Windows"],
      action: "trash"
    });
    expect(absolute.status).toBe(400);
  });

  it("rechaza selección vacía, acción inválida y proyecto fuera de la raíz", async () => {
    const { app, target } = await makeContext();
    const empty = await post(app, "/api/plan", {
      projectPath: target,
      selectedRelativePaths: [],
      action: "trash"
    });
    expect(empty.status).toBe(400);
    const badAction = await post(app, "/api/plan", {
      projectPath: target,
      selectedRelativePaths: ["dist"],
      action: "borrar"
    });
    expect(badAction.status).toBe(400);
    const outside = await post(app, "/api/plan", {
      projectPath: os.tmpdir(),
      selectedRelativePaths: ["dist"],
      action: "trash"
    });
    expect(outside.status).toBe(400);
  });
});

describe("POST /api/clean — confirmación y ejecución", () => {
  async function makePlan(
    context: TestContext,
    selected: string[],
    action: "trash" | "permanent" = "trash"
  ): Promise<string> {
    const response = await post(context.app, "/api/plan", {
      projectPath: context.target,
      selectedRelativePaths: selected,
      action
    });
    expect(response.status).toBe(200);
    const data = await jsonOf(response);
    return (data.plan as { id: string }).id;
  }

  it("rechaza sin confirmación explícita (false, string o ausente)", async () => {
    const context = await makeContext();
    const planId = await makePlan(context, ["dist"]);
    for (const confirmed of [false, "true", undefined]) {
      const response = await post(context.app, "/api/clean", {
        planId,
        confirmed,
        action: "trash"
      });
      expect(response.status).toBe(400);
      expect((await jsonOf(response)).error).toMatch(/confirmación/i);
    }
    // El plan sigue intacto y nada se eliminó.
    expect(await fs.stat(path.join(context.target, "dist"))).toBeTruthy();
  });

  it("rechaza planes inexistentes o expirados", async () => {
    const context = await makeContext();
    const missing = await post(context.app, "/api/clean", {
      planId: "00000000-0000-0000-0000-000000000000",
      confirmed: true,
      action: "trash"
    });
    expect(missing.status).toBe(404);

    const expiredContext = await makeContext(0); // caduca inmediatamente
    const planId = await makePlan(expiredContext, ["dist"]);
    const expired = await post(expiredContext.app, "/api/clean", {
      planId,
      confirmed: true,
      action: "trash"
    });
    expect(expired.status).toBe(410);
    expect(
      await fs.stat(path.join(expiredContext.target, "dist"))
    ).toBeTruthy();
  });

  it("rechaza cambiar la acción respecto a la del plan", async () => {
    const context = await makeContext();
    const planId = await makePlan(context, ["dist"], "trash");
    const response = await post(context.app, "/api/clean", {
      planId,
      confirmed: true,
      action: "permanent"
    });
    expect(response.status).toBe(400);
    expect(await fs.stat(path.join(context.target, "dist"))).toBeTruthy();
  });

  it("ejecuta con papelera, audita y expone el informe por ID", async () => {
    const context = await makeContext();
    const planId = await makePlan(context, ["node_modules", "dist"]);
    const response = await post(context.app, "/api/clean", {
      planId,
      confirmed: true,
      action: "trash"
    });
    expect(response.status).toBe(200);
    const data = await jsonOf(response);
    const result = data.result as CleanResult;
    expect(result.executedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.action).toBe("trash");
    expect(result.trashSessionDir).toBeTruthy();

    await expect(
      fs.stat(path.join(context.target, "node_modules"))
    ).rejects.toThrow();
    await expect(fs.stat(path.join(context.target, "dist"))).rejects.toThrow();
    expect(await fs.stat(path.join(context.target, ".env"))).toBeTruthy();
    expect(await fs.stat(path.join(context.target, "src"))).toBeTruthy();

    const records = await readAudit(context.auditPath);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.result === "trashed")).toBe(true);
    expect(records.every((r) => r.approvedBy === "human")).toBe(true);

    // Informe accesible por ID (JSON y Markdown).
    const reportId = data.reportId as string;
    const jsonResponse = await context.app.request(`/api/report/${reportId}`);
    expect(jsonResponse.status).toBe(200);
    const stored = (await jsonResponse.json()) as { clean: CleanResult };
    expect(stored.clean.id).toBe(result.id);
    const mdResponse = await context.app.request(
      `/api/report/${reportId}?format=markdown&download=1`
    );
    expect(mdResponse.status).toBe(200);
    expect(mdResponse.headers.get("content-disposition")).toMatch(/attachment/);
    expect(await mdResponse.text()).toContain("Informe de limpieza");

    // Replay del mismo plan: rechazado (un solo uso).
    const replay = await post(context.app, "/api/clean", {
      planId,
      confirmed: true,
      action: "trash"
    });
    expect(replay.status).toBe(404);
  });

  it("permanent solo se ejecuta si se solicitó al crear el plan", async () => {
    const context = await makeContext();
    const planId = await makePlan(context, ["debug.log"], "permanent");
    const response = await post(context.app, "/api/clean", {
      planId,
      confirmed: true,
      action: "permanent"
    });
    expect(response.status).toBe(200);
    const data = await jsonOf(response);
    expect((data.result as CleanResult).action).toBe("permanent");
    await expect(
      fs.stat(path.join(context.target, "debug.log"))
    ).rejects.toThrow();
    const records = await readAudit(context.auditPath);
    expect(records[0]?.result).toBe("deleted");
  });
});

describe("GET /api/report/:id", () => {
  it("rechaza IDs inválidos o desconocidos", async () => {
    const { app } = await makeContext();
    const invalid = await app.request("/api/report/bad_id!");
    expect(invalid.status).toBe(400);
    // El router resuelve "/api/report/.." antes del handler: nunca sirve
    // ficheros fuera del registro; como mucho devuelve 404.
    const traversal = await app.request("/api/report/..");
    expect([400, 404]).toContain(traversal.status);
    const unknown = await app.request(
      "/api/report/00000000-0000-0000-0000-000000000000"
    );
    expect(unknown.status).toBe(404);
  });

  it("expone el informe de escaneo generado por inspect", async () => {
    const { app, target } = await makeContext();
    const inspectResponse = await post(app, "/api/inspect", {
      projectPath: target
    });
    const report = (await inspectResponse.json()) as ScanReport;
    const response = await app.request(`/api/report/${report.id}`);
    expect(response.status).toBe(200);
    const stored = (await response.json()) as ScanReport;
    expect(stored.id).toBe(report.id);
  });
});

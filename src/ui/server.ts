import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type {
  CleanAction,
  CleanerRuleSet,
  CleanPlan,
  ReportPaths,
  RestoreConflictMode,
  RestorePlan,
  ScanReport,
  TrashSession
} from "../types/index.js";
import { scanProject, scanRoot } from "../core/scanner.js";
import { createCleanPlan, executeCleanPlan } from "../core/cleaner.js";
import {
  createRestorePlan,
  executeRestorePlan,
  listTrashSessions,
  readTrashSession,
  restorePlanHashOf,
  sessionItemStates
} from "../core/restore.js";
import {
  assessSessionEligibility,
  purgeTrashSession
} from "../core/trash-admin.js";
import { planHashOf } from "../core/trash.js";
import { verifyGitStatus } from "../core/git.js";
import { DEFAULT_AUDIT_PATH } from "../core/audit.js";
import {
  saveCleanResult,
  saveRestoreResult,
  saveRootScanReport,
  saveScanReport
} from "../core/report.js";
import {
  ApiError,
  assertValidId,
  ID_PATTERN,
  validateDirectoryWithinRoot,
  validateSelectors
} from "./validate.js";
import { formatBytes } from "../core/format.js";

export interface UiServerOptions {
  /** Única raíz autorizada para escaneo/inspección/limpieza. */
  allowedRoot: string;
  rules: CleanerRuleSet;
  rulesSource?: string;
  reportsDir?: string;
  auditPath?: string;
  /** Caducidad de los planes pendientes de confirmar (por defecto 15 min). */
  planTtlMs?: number;
}

interface StoredPlan {
  plan: CleanPlan;
  report: ScanReport;
  action: CleanAction;
  expiresAt: number;
}

interface StoredRestorePlan {
  plan: RestorePlan;
  session: TrashSession;
  expiresAt: number;
}

const DEFAULT_PLAN_TTL_MS = 15 * 60 * 1000;
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function publicAsset(name: string): string {
  const url = new URL(`./public/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function hostnameOf(hostHeader: string): string {
  return hostHeader
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
}

/**
 * Servidor local minimalista (Hono). Solo 127.0.0.1.
 * Reutiliza los servicios del núcleo: scanner, cleaner, safety guard
 * (dentro de executeCleanPlan), papelera, auditoría e informes.
 * Ningún endpoint ejecuta comandos arbitrarios.
 */
export function createServer(options: UiServerOptions): Hono {
  const allowedRoot = path.resolve(options.allowedRoot);
  const rules = options.rules;
  const rulesSource = options.rulesSource ?? "no especificado";
  const reportsDir = options.reportsDir ?? "reports";
  const auditPath = options.auditPath ?? DEFAULT_AUDIT_PATH;
  const planTtlMs = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS;

  const plans = new Map<string, StoredPlan>();
  const restorePlans = new Map<string, StoredRestorePlan>();
  const reports = new Map<string, ReportPaths>();

  const html = publicAsset("index.html").replaceAll(
    "__ALLOWED_ROOT__",
    escapeAttribute(allowedRoot)
  );
  const css = publicAsset("styles.css");
  const js = publicAsset("app.js");

  const app = new Hono();

  // Endurecimiento: solo Host/Origin locales (anti DNS-rebinding y CSRF).
  app.use("/api/*", async (c, next) => {
    // En peticiones reales siempre hay Host; como fallback se usa la URL.
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!LOCAL_HOSTNAMES.has(hostnameOf(host))) {
      return c.json({ error: "Host no autorizado: servidor solo local" }, 403);
    }
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      let originHost: string;
      try {
        originHost = new URL(origin).hostname.toLowerCase();
      } catch {
        return c.json({ error: "Origin inválido" }, 403);
      }
      if (!LOCAL_HOSTNAMES.has(originHost)) {
        return c.json(
          { error: "Origin no autorizado: servidor solo local" },
          403
        );
      }
    }
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: error.message }, error.status);
    }
    // Nunca stack traces al cliente.
    return c.json({ error: "Error interno del servidor" }, 500);
  });

  const securityHeaders = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store"
  } as const;

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  app.post("/api/scan", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new ApiError(400, "Cuerpo JSON inválido");
    }
    const rootPath = await validateDirectoryWithinRoot(
      (body as Record<string, unknown>).rootPath,
      allowedRoot,
      "rootPath"
    );
    const report = await scanRoot(rootPath, rules, { rulesSource });
    const paths = await saveRootScanReport(report, reportsDir);
    reports.set(report.id, paths);
    return c.json({
      reportId: report.id,
      root: report.root,
      generatedAt: report.generatedAt,
      summary: report.summary,
      warnings: report.warnings,
      // Sin entradas por proyecto: la lista solo necesita el resumen.
      projects: report.projects.map((project) => {
        const { entries: _entries, ...rest } = project;
        return rest;
      })
    });
  });

  app.post("/api/inspect", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new ApiError(400, "Cuerpo JSON inválido");
    }
    const projectPath = await validateDirectoryWithinRoot(
      (body as Record<string, unknown>).projectPath,
      allowedRoot,
      "projectPath"
    );
    const report = await scanProject(projectPath, rules);
    const paths = await saveScanReport(report, reportsDir);
    reports.set(report.id, paths);
    return c.json({ ...report, reportId: report.id });
  });

  app.post("/api/plan", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new ApiError(400, "Cuerpo JSON inválido");
    }
    const data = body as Record<string, unknown>;
    const projectPath = await validateDirectoryWithinRoot(
      data.projectPath,
      allowedRoot,
      "projectPath"
    );
    const action = data.action ?? "trash";
    if (action !== "trash" && action !== "permanent") {
      throw new ApiError(400, 'action debe ser "trash" o "permanent"');
    }
    const selected = validateSelectors(data.selectedRelativePaths);

    const report = await scanProject(projectPath, rules);
    let plan: CleanPlan;
    try {
      // createCleanPlan rechaza rutas protegidas y desconocidas.
      plan = createCleanPlan(report, { only: selected }, action);
    } catch (error) {
      throw new ApiError(
        400,
        error instanceof Error ? error.message : String(error)
      );
    }
    if (plan.items.length === 0) {
      throw new ApiError(400, "La selección no produce elementos limpiables");
    }
    const expiresAt = Date.now() + planTtlMs;
    plans.set(plan.id, { plan, report, action, expiresAt });
    return c.json({
      plan,
      planHash: planHashOf(plan),
      action,
      expiresAt: new Date(expiresAt).toISOString()
    });
  });

  app.post("/api/clean", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new ApiError(400, "Cuerpo JSON inválido");
    }
    const data = body as Record<string, unknown>;
    if (data.confirmed !== true) {
      throw new ApiError(
        400,
        "Confirmación explícita requerida: confirmed debe ser exactamente true. Confirma la acción antes de ejecutar."
      );
    }
    const planId = assertValidId(data.planId, "planId");
    const stored = plans.get(planId);
    if (!stored) {
      throw new ApiError(404, "El plan no existe o ya fue ejecutado");
    }
    if (Date.now() >= stored.expiresAt) {
      plans.delete(planId);
      throw new ApiError(
        410,
        "El plan ha expirado (validez de 15 minutos). Genera un plan nuevo desde la inspección."
      );
    }
    const action = data.action ?? stored.action;
    if (action !== stored.action) {
      throw new ApiError(
        400,
        "La acción no coincide con la del plan: permanent solo si se solicitó al crearlo"
      );
    }
    // Revalidación del target contra la raíz autorizada en el momento de ejecutar.
    await validateDirectoryWithinRoot(
      stored.plan.target,
      allowedRoot,
      "plan.target"
    );
    if (stored.plan.items.some((item) => item.entry.risk === "protected")) {
      throw new ApiError(
        400,
        "El plan contiene rutas protegidas: nunca eliminables"
      );
    }

    // Un solo uso: evita reejecuciones/replay.
    plans.delete(planId);

    // executeCleanPlan aplica el Safety Guard elemento a elemento,
    // usa la papelera por defecto y registra la auditoría.
    const result = await executeCleanPlan(stored.plan, rules, { auditPath });
    result.git = verifyGitStatus(result.target);
    if (result.git.available && result.git.deletedTracked.length > 0) {
      result.warnings.push(
        `Git detecta ${result.git.deletedTracked.length} ficheros versionados eliminados: revisa el informe.`
      );
    }
    const paths = await saveCleanResult(result, stored.report, reportsDir);
    reports.set(result.id, paths);
    return c.json({ result, reportId: result.id });
  });

  app.get("/api/trash/:projectPath", async (c) => {
    const projectPath = await validateDirectoryWithinRoot(
      c.req.param("projectPath"),
      allowedRoot,
      "projectPath"
    );
    const sessions = await listTrashSessions(projectPath);
    return c.json({ sessions });
  });

  app.get("/api/trash/:projectPath/:sessionId", async (c) => {
    const projectPath = await validateDirectoryWithinRoot(
      c.req.param("projectPath"),
      allowedRoot,
      "projectPath"
    );
    const sessionId = assertValidId(c.req.param("sessionId"), "sessionId");
    let session: TrashSession;
    try {
      session = await readTrashSession(projectPath, sessionId);
    } catch (error) {
      throw new ApiError(
        404,
        error instanceof Error ? error.message : String(error)
      );
    }
    const items = await sessionItemStates(session);
    return c.json({ session, items });
  });

  app.post("/api/restore/plan", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new ApiError(400, "Cuerpo JSON inválido");
    }
    const data = body as Record<string, unknown>;
    const projectPath = await validateDirectoryWithinRoot(
      data.projectPath,
      allowedRoot,
      "projectPath"
    );
    const sessionId = assertValidId(data.sessionId, "sessionId");
    const onConflict = data.onConflict ?? "cancel";
    if (
      onConflict !== "cancel" &&
      onConflict !== "suffix" &&
      onConflict !== "overwrite"
    ) {
      throw new ApiError(400, "onConflict debe ser cancel, suffix u overwrite");
    }
    const selection =
      data.all === true
        ? { all: true }
        : { only: validateSelectors(data.selectedRelativePaths) };

    let session: TrashSession;
    try {
      session = await readTrashSession(projectPath, sessionId);
    } catch (error) {
      throw new ApiError(
        404,
        error instanceof Error ? error.message : String(error)
      );
    }
    let plan: RestorePlan;
    try {
      plan = await createRestorePlan(projectPath, session, selection, {
        onConflict: onConflict as RestoreConflictMode
      });
    } catch (error) {
      throw new ApiError(
        400,
        error instanceof Error ? error.message : String(error)
      );
    }
    const expiresAt = Date.now() + planTtlMs;
    restorePlans.set(plan.id, { plan, session, expiresAt });
    return c.json({
      plan,
      planHash: restorePlanHashOf(plan),
      expiresAt: new Date(expiresAt).toISOString()
    });
  });

  app.post("/api/restore/execute", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new ApiError(400, "Cuerpo JSON inválido");
    }
    const data = body as Record<string, unknown>;
    if (data.confirmed !== true) {
      throw new ApiError(
        400,
        "Confirmación explícita requerida: confirmed debe ser exactamente true. Confirma la acción antes de ejecutar."
      );
    }
    const planId = assertValidId(data.planId, "planId");
    const stored = restorePlans.get(planId);
    if (!stored) {
      throw new ApiError(
        404,
        "El plan de restauración no existe o ya fue ejecutado"
      );
    }
    if (Date.now() >= stored.expiresAt) {
      restorePlans.delete(planId);
      throw new ApiError(
        410,
        "El plan de restauración ha expirado (validez de 15 minutos). Genera uno nuevo desde la papelera."
      );
    }
    await validateDirectoryWithinRoot(
      stored.plan.target,
      allowedRoot,
      "plan.target"
    );
    const needsOverwrite = stored.plan.items.some(
      (item) =>
        item.approved && item.conflict && item.resolution === "overwrite"
    );
    if (needsOverwrite) {
      if (data.overwriteConfirmed !== true) {
        throw new ApiError(
          400,
          "Sobrescribir rutas existentes requiere confirmación adicional explícita (overwriteConfirmed: true)"
        );
      }
      stored.plan.overwriteApproved = true;
    }

    // Un solo uso: evita reejecuciones.
    restorePlans.delete(planId);
    const result = await executeRestorePlan(stored.plan, rules, { auditPath });
    const paths = await saveRestoreResult(result, reportsDir);
    reports.set(result.id, paths);
    return c.json({ result, reportId: result.id });
  });

  /* ---------- Informes históricos (fase 5, D1) ---------- */

  interface ReportListItem {
    id: string;
    kind: "scan" | "inspect" | "clean" | "restore" | "trash" | "unknown";
    filename: string;
    generatedAt: string;
    target: string;
    summary: string;
    status: string;
  }

  /**
   * Indexa los informes del directorio autorizado (solo lectura).
   * Nunca construye rutas a partir de entrada del usuario: los nombres
   * proceden del readdir del directorio de informes.
   */
  async function indexReportsFromDisk(): Promise<ReportListItem[]> {
    const dir = path.resolve(reportsDir);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const items: ReportListItem[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const jsonPath = path.join(dir, name);
      if (!jsonPath.startsWith(dir + path.sep)) continue;
      try {
        const parsed = JSON.parse(
          await fs.readFile(jsonPath, "utf8")
        ) as Record<string, unknown> & {
          id?: string;
          clean?: {
            id?: string;
            target?: string;
            finishedAt?: string;
            executedCount?: number;
            failedCount?: number;
            freedBytes?: number;
          };
          root?: string;
          target?: string;
          generatedAt?: string;
          finishedAt?: string;
          summary?: { projectCount?: number; safeBytes?: number };
          entries?: unknown[];
          restoredCount?: number;
          restoredBytes?: number;
          failedCount?: number;
          purged?: Array<{ result?: string }>;
          freedBytes?: number;
        };
        const id =
          typeof parsed.id === "string"
            ? parsed.id
            : typeof parsed.clean?.id === "string"
              ? parsed.clean.id
              : null;
        if (!id || !ID_PATTERN.test(id)) continue;
        const kind: ReportListItem["kind"] = name.startsWith("root-scan-")
          ? "scan"
          : name.startsWith("scan-")
            ? "inspect"
            : name.startsWith("clean-")
              ? "clean"
              : name.startsWith("restore-")
                ? "restore"
                : name.startsWith("trash-")
                  ? "trash"
                  : "unknown";
        const markdownPath = path.join(dir, name.replace(/\.json$/, ".md"));
        reports.set(id, { json: jsonPath, markdown: markdownPath });

        const generatedAt =
          parsed.generatedAt ??
          parsed.clean?.finishedAt ??
          parsed.finishedAt ??
          "";
        const target =
          parsed.root ?? parsed.target ?? parsed.clean?.target ?? "";
        let summary = "";
        let status = "solo lectura";
        if (kind === "scan") {
          summary = `${parsed.summary?.projectCount ?? 0} proyectos · ${formatBytes(parsed.summary?.safeBytes ?? 0)} safe`;
        } else if (kind === "inspect") {
          summary = `${parsed.entries?.length ?? 0} elementos · ${formatBytes(parsed.summary?.safeBytes ?? 0)} safe`;
        } else if (kind === "clean") {
          summary = `${parsed.clean?.executedCount ?? 0} ejecutados · ${formatBytes(parsed.clean?.freedBytes ?? 0)} liberados`;
          status =
            (parsed.clean?.failedCount ?? 0) > 0 ? "con errores" : "completado";
        } else if (kind === "restore") {
          summary = `${parsed.restoredCount ?? 0} restaurados · ${formatBytes(parsed.restoredBytes ?? 0)}`;
          status = (parsed.failedCount ?? 0) > 0 ? "con errores" : "completado";
        } else if (kind === "trash") {
          const purgedCount = (parsed.purged ?? []).filter(
            (p) => p.result === "purged"
          ).length;
          summary = `${purgedCount} sesiones eliminadas · ${formatBytes(parsed.freedBytes ?? 0)}`;
          status = "completado";
        }
        items.push({
          id,
          kind,
          filename: name,
          generatedAt,
          target,
          summary,
          status
        });
      } catch {
        continue; // informe corrupto o ilegible: se omite
      }
    }
    items.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    return items;
  }

  async function resolveReportPaths(id: string): Promise<ReportPaths> {
    const registered = reports.get(id);
    if (registered) return registered;
    await indexReportsFromDisk();
    const found = reports.get(id);
    if (!found)
      throw new ApiError(
        404,
        "Informe no encontrado. Actualiza el listado de informes; puede que el servidor se haya reiniciado."
      );
    return found;
  }

  app.post("/api/trash/purge", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new ApiError(400, "Cuerpo JSON inválido");
    }
    const data = body as Record<string, unknown>;
    if (data.confirmed !== true) {
      throw new ApiError(
        400,
        "Confirmación explícita requerida: confirmed debe ser exactamente true. La purga elimina sesiones de papelera; el registro de auditoría se conserva."
      );
    }
    const projectPath = await validateDirectoryWithinRoot(
      data.projectPath,
      allowedRoot,
      "projectPath"
    );
    const sessions = await listTrashSessions(projectPath);
    let eligible = sessions.filter(
      (s) => assessSessionEligibility(s).removable
    );
    if (Array.isArray(data.sessionIds)) {
      const wanted = new Set(
        data.sessionIds.filter((x): x is string => typeof x === "string")
      );
      eligible = eligible.filter((s) => wanted.has(s.sessionId));
    }
    const purged = [];
    for (const session of eligible) {
      purged.push(
        await purgeTrashSession(projectPath, session.sessionId, { auditPath })
      );
    }
    const purgedIds = new Set(
      purged.filter((p) => p.result === "purged").map((p) => p.sessionId)
    );
    return c.json({
      purged,
      kept: sessions
        .filter((s) => !purgedIds.has(s.sessionId))
        .map((s) => s.sessionId),
      freedBytes: purged
        .filter((p) => p.result === "purged")
        .reduce((acc, p) => acc + p.sizeBytes, 0)
    });
  });

  app.get("/api/reports", async (c) => {
    return c.json({ reports: await indexReportsFromDisk() });
  });

  app.get("/api/reports/:id", async (c) => {
    const id = assertValidId(c.req.param("id"), "id");
    const paths = await resolveReportPaths(id);
    const content = await fs.readFile(paths.json, "utf8").catch(() => null);
    if (content === null) throw new ApiError(404, "Informe no accesible");
    return c.body(content, 200, {
      ...securityHeaders,
      "Content-Type": "application/json; charset=utf-8"
    });
  });

  app.get("/api/reports/:id/download", async (c) => {
    const id = assertValidId(c.req.param("id"), "id");
    const format = c.req.query("format") ?? "json";
    if (format !== "json" && format !== "md") {
      throw new ApiError(400, 'format debe ser "json" o "md"');
    }
    const paths = await resolveReportPaths(id);
    const filePath = format === "md" ? paths.markdown : paths.json;
    const content = await fs.readFile(filePath, "utf8").catch(() => null);
    if (content === null) {
      throw new ApiError(404, "Informe no disponible en ese formato");
    }
    return c.body(content, 200, {
      ...securityHeaders,
      "Content-Type":
        format === "md"
          ? "text/markdown; charset=utf-8"
          : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${path.basename(filePath)}"`
    });
  });

  app.get("/api/report/:id", async (c) => {
    const id = assertValidId(c.req.param("id"), "id");
    const registered = reports.get(id);
    if (!registered) {
      throw new ApiError(
        404,
        "Informe no encontrado. Actualiza el listado de informes; puede que el servidor se haya reiniciado."
      );
    }
    const format = c.req.query("format") ?? "json";
    const download = c.req.query("download") === "1";
    if (format !== "json" && format !== "markdown") {
      throw new ApiError(400, 'format debe ser "json" o "markdown"');
    }
    const filePath =
      format === "markdown" ? registered.markdown : registered.json;
    const content = readFileSync(filePath, "utf8");
    const headers: Record<string, string> = {
      ...securityHeaders,
      "Content-Type":
        format === "markdown"
          ? "text/markdown; charset=utf-8"
          : "application/json; charset=utf-8"
    };
    if (download) {
      headers["Content-Disposition"] =
        `attachment; filename="${path.basename(filePath)}"`;
    }
    return c.body(content, 200, headers);
  });

  app.get("/", (c) =>
    c.html(html, 200, {
      ...securityHeaders,
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'"
    })
  );
  app.get("/styles.css", (c) =>
    c.body(css, 200, {
      ...securityHeaders,
      "Content-Type": "text/css; charset=utf-8"
    })
  );
  app.get("/app.js", (c) =>
    c.body(js, 200, {
      ...securityHeaders,
      "Content-Type": "text/javascript; charset=utf-8"
    })
  );
  app.get("/favicon.ico", (c) => c.body(null, 204));

  return app;
}

/** Arranca el servidor exclusivamente en 127.0.0.1. */
export function startServer(
  options: UiServerOptions,
  port: number
): ReturnType<typeof serve> {
  const app = createServer(options);
  return serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
}

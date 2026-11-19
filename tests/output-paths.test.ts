import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveAuditPath,
  resolveReportsDir,
  writableOutputBase
} from "../src/core/output-paths.js";
import { appendAudit } from "../src/core/audit.js";
import { createServer } from "../src/ui/server.js";
import { DEFAULT_RULES } from "../src/rules/defaults.js";
import { makeFixture } from "./helpers.js";
import type { AuditRecord } from "../src/types/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("output-paths — destino escribible coherente", () => {
  it("respeta rutas explícitas", () => {
    expect(resolveReportsDir("C:/datos/informes")).toBe(
      path.resolve("C:/datos/informes")
    );
    expect(resolveAuditPath("C:/datos/audit.jsonl")).toBe(
      path.resolve("C:/datos/audit.jsonl")
    );
  });

  it("por defecto usa el cwd si es escribible", () => {
    expect(writableOutputBase()).toBe(process.cwd());
    expect(resolveReportsDir()).toBe(path.join(process.cwd(), "reports"));
    expect(resolveAuditPath()).toBe(
      path.join(process.cwd(), "logs", "clean-audit.jsonl")
    );
  });

  it("cwd no escribible/inexistente -> fallback a ~/.repo-cleaner", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "rc-home-"));
    tempDirs.push(home);
    vi.spyOn(process, "cwd").mockReturnValue(
      path.join(home, "no-existe-jamas")
    );
    vi.spyOn(os, "homedir").mockReturnValue(home);
    expect(writableOutputBase()).toBe(path.join(home, ".repo-cleaner"));
    expect(resolveReportsDir()).toBe(
      path.join(home, ".repo-cleaner", "reports")
    );
    expect(resolveAuditPath()).toBe(
      path.join(home, ".repo-cleaner", "logs", "clean-audit.jsonl")
    );
  });

  it("sonda de escritura EPERM (clase System32 en Windows) -> fallback", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "rc-home-"));
    tempDirs.push(home);
    // cwd existente pero "protegido": la sonda de escritura falla con EPERM,
    // igual que en C:\Windows\System32 (accessSync W_OK allí da falso positivo).
    vi.spyOn(process, "cwd").mockReturnValue(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(fsSync, "mkdtempSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), {
        code: "EPERM"
      });
    });
    expect(writableOutputBase()).toBe(path.join(home, ".repo-cleaner"));
    expect(resolveReportsDir()).toBe(
      path.join(home, ".repo-cleaner", "reports")
    );
  });

  it("appendAudit escribe en el fallback cuando el cwd no es escribible", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "rc-home-"));
    tempDirs.push(home);
    vi.spyOn(process, "cwd").mockReturnValue(
      path.join(home, "no-existe-jamas")
    );
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const record: AuditRecord = {
      timestamp: new Date().toISOString(),
      target: "C:/proyecto",
      relativePath: "dist",
      risk: "safe",
      action: "trash",
      sizeBytes: 1,
      approvedBy: "human",
      result: "trashed"
    };
    const written = await appendAudit(record);
    expect(written).toBe(
      path.join(home, ".repo-cleaner", "logs", "clean-audit.jsonl")
    );
    expect(await fs.stat(written)).toBeTruthy();
  });
});

describe("regresión: POST /api/scan con cwd no escribible (clase System32)", () => {
  it("escanea y guarda informes en el fallback sin devolver 500", async () => {
    const root = await makeFixture();
    tempDirs.push(root);
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "rc-home-"));
    tempDirs.push(home);
    // Simula un cwd como C:\Windows\System32 (no escribible) sin tocarlo.
    vi.spyOn(process, "cwd").mockReturnValue(path.join(home, "cwd-prohibido"));
    vi.spyOn(os, "homedir").mockReturnValue(home);

    const app = createServer({ allowedRoot: root, rules: DEFAULT_RULES });
    const response = await app.request("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath: root })
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      reportId: string;
      summary: { projectCount: number };
    };
    expect(data.summary.projectCount).toBe(3);
    const fallbackReports = path.join(home, ".repo-cleaner", "reports");
    const files = await fs.readdir(fallbackReports);
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);
    expect(files.some((f) => f.endsWith(".md"))).toBe(true);
    // El informe es accesible por ID desde el fallback.
    const detail = await app.request(`/api/reports/${data.reportId}`);
    expect(detail.status).toBe(200);
  });

  it("las rutas explícitas se respetan aunque el cwd no sea escribible", async () => {
    const root = await makeFixture();
    tempDirs.push(root);
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "rc-home-"));
    tempDirs.push(home);
    const explicit = path.join(home, "mis-informes");
    vi.spyOn(process, "cwd").mockReturnValue(path.join(home, "cwd-prohibido"));
    vi.spyOn(os, "homedir").mockReturnValue(home);

    const app = createServer({
      allowedRoot: root,
      rules: DEFAULT_RULES,
      reportsDir: explicit
    });
    const response = await app.request("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath: root })
    });
    expect(response.status).toBe(200);
    expect((await fs.readdir(explicit)).length).toBeGreaterThan(0);
    await expect(fs.stat(path.join(home, ".repo-cleaner"))).rejects.toThrow();
  });
});

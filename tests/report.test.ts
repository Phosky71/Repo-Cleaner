import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanProject, scanRoot } from "../src/core/scanner.js";
import { saveRootScanReport, saveScanReport } from "../src/core/report.js";
import { makeFixture, testRules } from "./helpers.js";
import type { RootScanReport, ScanReport } from "../src/types/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempReportsDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-reports-"));
  tempDirs.push(dir);
  return dir;
}

describe("saveRootScanReport", () => {
  it("genera JSON y Markdown auditables en el directorio indicado", async () => {
    const root = await makeFixture();
    tempDirs.push(root);
    const reportsDir = await tempReportsDir();
    const report = await scanRoot(root, testRules(), {
      rulesSource: "test"
    });
    const paths = await saveRootScanReport(report, reportsDir);

    expect(paths.json.startsWith(reportsDir)).toBe(true);
    expect(paths.markdown.startsWith(reportsDir)).toBe(true);

    const parsed = JSON.parse(
      await fs.readFile(paths.json, "utf8")
    ) as RootScanReport;
    expect(parsed.id).toBe(report.id);
    expect(parsed.projects).toHaveLength(report.projects.length);
    expect(parsed.summary.projectCount).toBe(3);

    const markdown = await fs.readFile(paths.markdown, "utf8");
    expect(markdown).toContain("# Informe de escaneo de raíz");
    expect(markdown).toContain("proj-node");
    expect(markdown).toContain("node_modules");
    expect(markdown).toContain("safe");
    expect(markdown).toContain("solo lectura");
  });
});

describe("saveScanReport", () => {
  it("genera el informe de un proyecto concreto", async () => {
    const root = await makeFixture();
    tempDirs.push(root);
    const reportsDir = await tempReportsDir();
    const report = await scanProject(path.join(root, "proj-py"), testRules());
    const paths = await saveScanReport(report, reportsDir);

    const parsed = JSON.parse(
      await fs.readFile(paths.json, "utf8")
    ) as ScanReport;
    expect(parsed.target).toBe(report.target);
    expect(parsed.entries.length).toBeGreaterThan(0);

    const markdown = await fs.readFile(paths.markdown, "utf8");
    expect(markdown).toContain("# Informe de escaneo de proyecto");
    expect(markdown).toContain("__pycache__");
  });
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectRepository } from "../src/core/inspect.js";
import { verifyGitStatus } from "../src/core/git.js";
import type { ScanReport } from "../src/types/index.js";
import { listFiles, makeFixture, testRules } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("inspectRepository", () => {
  it("genera informe JSON y Markdown sin modificar ningún archivo", async () => {
    const root = await makeFixture();
    tempDirs.push(root);
    const reportsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-cleaner-inspect-")
    );
    tempDirs.push(reportsDir);
    const target = path.join(root, "proj-node");

    const before = await listFiles(target);
    const { report, paths } = await inspectRepository(target, testRules(), {
      reportsDir
    });
    expect(await listFiles(target)).toEqual(before);

    expect(report.projectTypes).toEqual(["typescript", "nodejs"]);
    expect(report.entries.length).toBeGreaterThan(0);

    const parsed = JSON.parse(
      await fs.readFile(paths.json, "utf8")
    ) as ScanReport;
    expect(parsed.id).toBe(report.id);
    expect(parsed.target).toBe(target);

    const markdown = await fs.readFile(paths.markdown, "utf8");
    expect(markdown).toContain("# Informe de escaneo de proyecto");
    expect(markdown).toContain("TypeScript");
    expect(markdown).toContain("node_modules");
    expect(markdown).toContain("Regla");
    expect(markdown).toContain("solo lectura");
  });

  it("falla si la ruta no existe o no es un directorio", async () => {
    const root = await makeFixture();
    tempDirs.push(root);
    await expect(
      inspectRepository(path.join(root, "fantasma"), testRules())
    ).rejects.toThrow(/no existe/);
    await expect(
      inspectRepository(path.join(root, "proj-node", "debug.log"), testRules())
    ).rejects.toThrow(/no es un directorio/);
  });
});

describe("verifyGitStatus", () => {
  it("informa con elegancia cuando no hay repositorio Git", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-git-"));
    tempDirs.push(dir);
    const verification = verifyGitStatus(dir);
    expect(verification.available).toBe(false);
    expect(verification.deletedTracked).toEqual([]);
  });

  it("no falla si .git existe pero git no puede ejecutarse", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-git-"));
    tempDirs.push(dir);
    await fs.mkdir(path.join(dir, ".git"));
    const verification = verifyGitStatus(dir);
    // .git falso: git status fallará; debe degradar sin lanzar excepción.
    expect(verification.deletedTracked).toEqual([]);
    expect(typeof verification.output).toBe("string");
  });
});

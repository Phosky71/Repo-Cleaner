import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeFixture } from "./helpers.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

const LEGACY_FILES = [
  "src/index.ts",
  "src/scanner.ts",
  "src/rules.ts",
  "src/cleaner.ts",
  "src/report.ts",
  "src/config.ts",
  "src/utils.ts"
];

interface BackupManifest {
  createdAt: string;
  reason: string;
  files: Array<{
    originalPath: string;
    backupPath: string;
    sha256: string;
    sizeBytes: number;
  }>;
}

describe("retirada del legacy v0", () => {
  it("los archivos legacy ya no existen en src/", async () => {
    for (const rel of LEGACY_FILES) {
      expect(
        await fs.stat(path.join(repoRoot, rel)).catch(() => null)
      ).toBeNull();
    }
  });

  it("existe un backup completo con hashes SHA-256 verificados", async () => {
    const legacyDir = path.join(repoRoot, "legacy");
    const backups = (await fs.readdir(legacyDir)).filter((name) =>
      name.startsWith("v0-backup-")
    );
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const backupDir = path.join(legacyDir, backups[0] ?? "");
    const manifest = JSON.parse(
      await fs.readFile(path.join(backupDir, "manifest.json"), "utf8")
    ) as BackupManifest;
    expect(manifest.files).toHaveLength(LEGACY_FILES.length);
    for (const file of manifest.files) {
      const content = await fs.readFile(path.join(backupDir, file.backupPath));
      const hash = createHash("sha256").update(content).digest("hex");
      expect(hash).toBe(file.sha256);
      expect(content.length).toBe(file.sizeBytes);
    }
  });

  it("la CLI modular sigue funcionando tras la retirada (smoke test)", async () => {
    const fixtureRoot = await makeFixture();
    tempDirs.push(fixtureRoot);
    const reportsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-cleaner-cli-smoke-")
    );
    tempDirs.push(reportsDir);

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "scan",
        fixtureRoot,
        "--reports-dir",
        reportsDir
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 60000 }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Proyectos detectados");
    expect(result.stdout).toContain("proj-node");
    const reports = await fs.readdir(reportsDir);
    expect(reports.some((f) => f.endsWith(".json"))).toBe(true);
    expect(reports.some((f) => f.endsWith(".md"))).toBe(true);
  });
});

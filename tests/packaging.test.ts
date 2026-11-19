import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const distEntry = path.join(repoRoot, "dist", "cli", "index.js");
const hasDist = existsSync(distEntry);
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

interface PackageJson {
  name: string;
  version: string;
  description: string;
  type: string;
  license: string;
  keywords: string[];
  files: string[];
  bin: Record<string, string>;
  engines: Record<string, string>;
  scripts: Record<string, string>;
}

const pkg = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8")
) as PackageJson;

describe("empaquetado — metadatos", () => {
  it("package.json tiene los metadatos necesarios", () => {
    expect(pkg.name).toBe("repo-cleaner");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.description.length).toBeGreaterThan(10);
    expect(pkg.type).toBe("module");
    expect(pkg.license).toBeTruthy();
    expect(pkg.keywords.length).toBeGreaterThan(3);
    expect(pkg.engines.node).toBeTruthy();
    expect(pkg.bin["repo-cleaner"]).toBe("./dist/cli/index.js");
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("config");
    expect(pkg.files).toContain("README.md");
    expect(pkg.scripts["verify:package"]).toBeTruthy();
    expect(
      existsSync(path.join(repoRoot, "scripts", "verify-package.mjs"))
    ).toBe(true);
  });
});

describe("empaquetado — build y entrypoint", () => {
  it.skipIf(!hasDist)("dist/cli/index.js existe con shebang", () => {
    const head = readFileSync(distEntry, "utf8").slice(0, 40);
    expect(head.startsWith("#!")).toBe(true);
  });

  it.skipIf(!hasDist)("assets de la UI copiados a dist/", () => {
    for (const asset of ["index.html", "styles.css", "app.js"]) {
      expect(
        existsSync(path.join(repoRoot, "dist", "ui", "public", asset))
      ).toBe(true);
    }
  });

  it.skipIf(!hasDist)(
    "reglas cargables desde el paquete construido",
    async () => {
      const loaderUrl = pathToFileURL(
        path.join(repoRoot, "dist", "rules", "loader.js")
      ).href;
      const { loadRules } = (await import(loaderUrl)) as {
        loadRules: (
          p?: string
        ) => Promise<{ rules: { version: number; safe: string[] } }>;
      };
      const { rules } = await loadRules(
        path.join(repoRoot, "config", "rules.json")
      );
      expect(rules.version).toBe(1);
      expect(rules.safe).toContain("node_modules");
    }
  );

  it.skipIf(!hasDist)("repo-cleaner --help funciona desde dist", () => {
    const result = spawnSync(process.execPath, [distEntry, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60000
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("scan");
    expect(result.stdout).toContain("restore");
    expect(result.stdout).toContain("trash");
    expect(result.stdout).toContain("ui");
  });

  it.skipIf(!hasDist)("repo-cleaner rules funciona desde dist", () => {
    const result = spawnSync(
      process.execPath,
      [distEntry, "rules", "--config", "config/rules.json"],
      { cwd: repoRoot, encoding: "utf8", timeout: 60000 }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("safe");
    expect(result.stdout).toContain("protected");
  });

  it.skipIf(!hasDist)(
    "servidor UI compilado arranca en localhost y responde health",
    async () => {
      const serverUrl = pathToFileURL(
        path.join(repoRoot, "dist", "ui", "server.js")
      ).href;
      const loaderUrl = pathToFileURL(
        path.join(repoRoot, "dist", "rules", "loader.js")
      ).href;
      const { startServer } = (await import(serverUrl)) as {
        startServer: (o: unknown, p: number) => Server;
      };
      const { loadRules } = (await import(loaderUrl)) as {
        loadRules: (p?: string) => Promise<{ rules: unknown }>;
      };
      const { rules } = await loadRules(
        path.join(repoRoot, "config", "rules.json")
      );
      const fixture = await fs.mkdtemp(
        path.join(os.tmpdir(), "repo-cleaner-pkg-")
      );
      tempDirs.push(fixture);
      const server = startServer({ allowedRoot: fixture, rules }, 0);
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      try {
        const address = server.address() as AddressInfo;
        expect(address.address).toBe("127.0.0.1");
        const health = await fetch(
          `http://127.0.0.1:${address.port}/api/health`
        );
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({ status: "ok" });
        const home = await fetch(`http://127.0.0.1:${address.port}/`);
        expect(home.status).toBe(200);
        expect(await home.text()).toContain("Repo Cleaner");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
});

describe("empaquetado — comando global (npm link)", () => {
  const probe = spawnSync("repo-cleaner --version", {
    shell: true,
    encoding: "utf8",
    timeout: 60000
  });
  const linked = probe.status === 0;

  it.runIf(linked)(
    "repo-cleaner global responde desde cualquier directorio",
    () => {
      const result = spawnSync("repo-cleaner --version", {
        cwd: os.tmpdir(),
        shell: true,
        encoding: "utf8",
        timeout: 60000
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(pkg.version);
    }
  );

  it.runIf(linked)(
    "repo-cleaner rules global carga las reglas del paquete",
    () => {
      const result = spawnSync(
        `repo-cleaner rules --config "${path.join(repoRoot, "config", "rules.json")}"`,
        { cwd: os.tmpdir(), shell: true, encoding: "utf8", timeout: 60000 }
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("node_modules");
    }
  );
});

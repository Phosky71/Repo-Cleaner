import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProjectMeta } from "../src/core/project-meta.js";
import { scanProject } from "../src/core/scanner.js";
import { inspectRepository } from "../src/core/inspect.js";
import { createServer } from "../src/ui/server.js";
import { DEFAULT_RULES } from "../src/rules/defaults.js";
import { listFiles, testRules, writeFixtureFile } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function project(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-meta-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    await writeFixtureFile(dir, rel, content);
  }
  return dir;
}

describe("detectProjectMeta — tipos y lenguajes", () => {
  it("detecta Node.js/TypeScript, Python, Rust, Go y .NET con evidencia", async () => {
    const node = await project({
      "package.json": '{"name":"x"}',
      "tsconfig.json": "{}",
      "index.ts": "export const a = 1;"
    });
    const nodeMeta = await detectProjectMeta(node, { checkGit: false });
    expect(nodeMeta.types).toEqual(["typescript", "nodejs"]);
    expect(nodeMeta.languages).toContain("TypeScript");
    expect(nodeMeta.languages).toContain("JavaScript");

    const py = await project({
      "pyproject.toml": "[project]",
      "app.py": "x=1"
    });
    expect((await detectProjectMeta(py, { checkGit: false })).types).toEqual([
      "python"
    ]);

    const rust = await project({
      "Cargo.toml": "[package]",
      "main.rs": "fn main(){}"
    });
    const rustMeta = await detectProjectMeta(rust, { checkGit: false });
    expect(rustMeta.types).toEqual(["rust"]);
    expect(rustMeta.languages).toContain("Rust");

    const go = await project({
      "go.mod": "module x",
      "main.go": "package main"
    });
    expect((await detectProjectMeta(go, { checkGit: false })).types).toEqual([
      "go"
    ]);

    const net = await project({ "App.csproj": "<Project/>", "App.sln": "" });
    const netMeta = await detectProjectMeta(net, { checkGit: false });
    expect(netMeta.types).toEqual(["dotnet"]);
    expect(netMeta.languages).toContain("C#");

    const fsproj = await project({ "App.fsproj": "<Project/>" });
    expect(
      (await detectProjectMeta(fsproj, { checkGit: false })).languages
    ).toContain("F#");
    const vbproj = await project({ "App.vbproj": "<Project/>" });
    expect(
      (await detectProjectMeta(vbproj, { checkGit: false })).languages
    ).toContain("VB.NET");
  });

  it("no inventa lenguajes sin evidencia", async () => {
    const dir = await project({ "notas.txt": "hola" });
    const meta = await detectProjectMeta(dir, { checkGit: false });
    expect(meta.types).toEqual(["unknown"]);
    expect(meta.languages).toEqual([]);
    expect(meta.packageManagers).toEqual([]);
    expect(meta.regenerationCommands).toEqual([]);
  });
});

describe("detectProjectMeta — gestores de paquetes", () => {
  it("detecta npm, pnpm, yarn, bun, pip, uv, poetry, cargo, go, gradle, maven, composer", async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ "package.json": "{}", "package-lock.json": "{}" }, "npm"],
      [{ "package.json": "{}", "pnpm-lock.yaml": "" }, "pnpm"],
      [{ "package.json": "{}", "yarn.lock": "" }, "yarn"],
      [{ "package.json": "{}", "bun.lock": "" }, "bun"],
      [{ "requirements.txt": "requests" }, "pip"],
      [{ "pyproject.toml": "", "uv.lock": "" }, "uv"],
      [{ "pyproject.toml": "", "poetry.lock": "" }, "poetry"],
      [{ "Cargo.toml": "", "Cargo.lock": "" }, "cargo"],
      [{ "go.mod": "", "go.sum": "" }, "go"],
      [{ "build.gradle": "", "gradle.lockfile": "" }, "gradle"],
      [{ "pom.xml": "" }, "maven"],
      [{ "composer.json": "{}", "composer.lock": "{}" }, "composer"]
    ];
    for (const [files, manager] of cases) {
      const dir = await project(files);
      const meta = await detectProjectMeta(dir, { checkGit: false });
      expect(meta.packageManagers).toContain(manager);
    }
  });

  it("pnpm prevalece sobre npm por defecto si hay lockfile", async () => {
    const dir = await project({
      "package.json": "{}",
      "pnpm-lock.yaml": ""
    });
    const meta = await detectProjectMeta(dir, { checkGit: false });
    expect(meta.packageManagers).toEqual(["pnpm"]);
  });
});

describe("detectProjectMeta — frameworks con evidencia", () => {
  it("detecta frameworks por configuración y dependencias", async () => {
    const dir = await project({
      "package.json": JSON.stringify({
        dependencies: { react: "^18", express: "^4", electron: "^30" },
        devDependencies: { "@nestjs/core": "^10", vue: "^3" }
      }),
      "next.config.js": "module.exports={}",
      "vite.config.ts": "export default {}",
      "svelte.config.js": "export default {}",
      "astro.config.mjs": "export default {}",
      "nuxt.config.ts": "export default {}",
      "src-tauri/tauri.conf.json": "{}"
    });
    const meta = await detectProjectMeta(dir, { checkGit: false });
    for (const framework of [
      "Next.js",
      "Nuxt",
      "SvelteKit",
      "Astro",
      "Vite",
      "React",
      "Vue",
      "Express",
      "NestJS",
      "Electron",
      "Tauri"
    ]) {
      expect(meta.frameworks).toContain(framework);
    }
  });

  it("detecta Django y FastAPI por evidencia Python", async () => {
    const django = await project({ "manage.py": "#!/usr/bin/env python" });
    expect(
      (await detectProjectMeta(django, { checkGit: false })).frameworks
    ).toContain("Django");
    const fastapi = await project({ "requirements.txt": "fastapi\nuvicorn" });
    expect(
      (await detectProjectMeta(fastapi, { checkGit: false })).frameworks
    ).toContain("FastAPI");
  });

  it("no incluye frameworks sin evidencia", async () => {
    const dir = await project({ "package.json": '{"name":"x"}' });
    const meta = await detectProjectMeta(dir, { checkGit: false });
    expect(meta.frameworks).toEqual([]);
  });
});

describe("detectProjectMeta — comandos de regeneración (solo recomendación)", () => {
  it("recomienda comandos según gestor y script de build", async () => {
    const npm = await project({
      "package.json": JSON.stringify({ scripts: { build: "tsc" } })
    });
    const npmMeta = await detectProjectMeta(npm, { checkGit: false });
    expect(npmMeta.regenerationCommands).toEqual([
      "npm install",
      "npm run build"
    ]);

    const noBuild = await project({ "package.json": "{}" });
    expect(
      (await detectProjectMeta(noBuild, { checkGit: false }))
        .regenerationCommands
    ).toEqual(["npm install"]);

    const pnpm = await project({
      "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      "pnpm-lock.yaml": ""
    });
    expect(
      (await detectProjectMeta(pnpm, { checkGit: false })).regenerationCommands
    ).toEqual(["pnpm install", "pnpm build"]);

    const uv = await project({ "pyproject.toml": "", "uv.lock": "" });
    expect(
      (await detectProjectMeta(uv, { checkGit: false })).regenerationCommands
    ).toContain("uv sync");

    const pip = await project({ "requirements.txt": "requests" });
    expect(
      (await detectProjectMeta(pip, { checkGit: false })).regenerationCommands
    ).toContain("pip install -r requirements.txt");

    const rust = await project({ "Cargo.toml": "", "Cargo.lock": "" });
    expect(
      (await detectProjectMeta(rust, { checkGit: false })).regenerationCommands
    ).toContain("cargo build");

    const go = await project({ "go.mod": "", "go.sum": "" });
    expect(
      (await detectProjectMeta(go, { checkGit: false })).regenerationCommands
    ).toContain("go build ./...");

    const net = await project({ "App.csproj": "" });
    expect(
      (await detectProjectMeta(net, { checkGit: false })).regenerationCommands
    ).toEqual(["dotnet restore", "dotnet build"]);

    const gradle = await project({ "build.gradle": "", gradlew: "#!/bin/sh" });
    expect(
      (await detectProjectMeta(gradle, { checkGit: false }))
        .regenerationCommands
    ).toContain("./gradlew build");

    const maven = await project({ "pom.xml": "" });
    expect(
      (await detectProjectMeta(maven, { checkGit: false })).regenerationCommands
    ).toContain("mvn clean install");
  });

  it("inspect no ejecuta ningún comando ni modifica archivos", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
      ".gitignore": "node_modules/\n",
      "node_modules/paquete/index.js": "x"
    });
    const before = await listFiles(dir);
    const { report } = await inspectRepository(dir, testRules());
    expect(report.meta.regenerationCommands.length).toBeGreaterThan(0);
    expect(await listFiles(dir)).toEqual(before);
  });
});

describe("detectProjectMeta — Git (solo lectura)", () => {
  it("no repositorio: isGitRepo false y sin cambios", async () => {
    const dir = await project({ "package.json": "{}" });
    const meta = await detectProjectMeta(dir);
    expect(meta.isGitRepo).toBe(false);
    expect(meta.gitPendingChanges).toBe(false);
  });

  it("repositorio presente: degrada con elegancia si git no está disponible", async () => {
    const dir = await project({
      "package.json": "{}",
      ".git/config": "[core]"
    });
    const meta = await detectProjectMeta(dir);
    expect(meta.isGitRepo).toBe(true);
    // .git falso: git status no disponible -> sin cambios, sin excepción.
    expect(meta.gitPendingChanges).toBe(false);
  });
});

describe("advertencias de zonas de riesgo", () => {
  it("avisa de .env y bases de datos dentro de carpetas safe", async () => {
    const dir = await project({
      "package.json": "{}",
      ".gitignore": "dist/\n",
      "dist/.env": "SECRET=1",
      "dist/datos.sqlite": "db",
      "dist/bundle.js": "x"
    });
    const report = await scanProject(dir, testRules());
    expect(report.warnings.some((w) => w.includes("dist/.env"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("dist/datos.sqlite"))).toBe(
      true
    );
    // La advertencia no cambia la clasificación por sí sola.
    const dist = report.entries.find((e) => e.relativePath === "dist");
    expect(dist?.risk).toBe("safe");
  });

  it("avisa si falta .gitignore o hay safe no ignorado por Git", async () => {
    const sinGitignore = await project({
      "package.json": "{}",
      "node_modules/paquete/index.js": "x"
    });
    const report1 = await scanProject(sinGitignore, testRules());
    expect(report1.warnings.some((w) => /no tiene \.gitignore/.test(w))).toBe(
      true
    );

    const noIgnorado = await project({
      "package.json": "{}",
      ".gitignore": "node_modules/\n",
      "dist/bundle.js": "x"
    });
    const report2 = await scanProject(noIgnorado, testRules());
    expect(report2.warnings.some((w) => /versionado/.test(w))).toBe(true);
  });
});

describe("integración de metadatos en inspect y UI", () => {
  it("el informe JSON/Markdown incluye metadatos y regeneración", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
      "tsconfig.json": "{}",
      ".gitignore": "node_modules/\n",
      "node_modules/paquete/index.js": "x"
    });
    const reportsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-cleaner-meta-rep-")
    );
    tempDirs.push(reportsDir);
    const { report, paths } = await inspectRepository(dir, testRules(), {
      reportsDir
    });
    expect(report.meta.languages).toContain("TypeScript");
    expect(report.meta.packageManagers).toContain("npm");
    const markdown = await fs.readFile(paths.markdown, "utf8");
    expect(markdown).toContain("**Lenguajes:**");
    expect(markdown).toContain("**Gestores de paquetes:**");
    expect(markdown).toContain("Regeneración recomendada");
    expect(markdown).toContain("npm run build");
  });

  it("POST /api/inspect devuelve meta para la UI", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ dependencies: { react: "^18" } }),
      "next.config.js": "module.exports={}"
    });
    const app = createServer({
      allowedRoot: dir,
      rules: DEFAULT_RULES,
      reportsDir: path.join(dir, "reports")
    });
    const response = await app.request("/api/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: dir })
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      meta: { frameworks: string[]; packageManagers: string[] };
    };
    expect(data.meta.frameworks).toContain("Next.js");
    expect(data.meta.frameworks).toContain("React");
    expect(data.meta.packageManagers).toContain("npm");
  });
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyPath } from "../src/core/rule-engine.js";
import { detectProjectType, scanProject } from "../src/core/scanner.js";
import { DEFAULT_RULES } from "../src/rules/defaults.js";
import { loadRules } from "../src/rules/loader.js";
import { testRules, writeFixtureFile } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("reglas .NET — bin/obj condicionados al tipo de proyecto", () => {
  it("bin y obj son safe en proyectos .NET", () => {
    expect(classifyPath("bin", DEFAULT_RULES, ["dotnet"]).risk).toBe("safe");
    expect(classifyPath("obj", DEFAULT_RULES, ["dotnet"]).risk).toBe("safe");
    expect(classifyPath("MiApp/bin", DEFAULT_RULES, ["dotnet"]).risk).toBe(
      "safe"
    );
  });

  it("bin y obj NO son safe sin tipo .NET detectado (ambigüedad -> review)", () => {
    expect(classifyPath("bin", DEFAULT_RULES).risk).toBe("review");
    expect(classifyPath("obj", DEFAULT_RULES).risk).toBe("review");
    expect(classifyPath("bin", DEFAULT_RULES, ["nodejs"]).risk).toBe("review");
    expect(classifyPath("bin", DEFAULT_RULES, ["python"]).risk).toBe("review");
    expect(classifyPath("bin", DEFAULT_RULES, ["unknown"]).risk).toBe("review");
  });

  it("las rutas protegidas ganan a las reglas .NET", () => {
    // src/ protege todo su contenido, incluidos bin/obj anidados: conservador.
    expect(classifyPath("src/bin", DEFAULT_RULES, ["dotnet"]).risk).toBe(
      "protected"
    );
    expect(classifyPath(".git/obj", DEFAULT_RULES, ["dotnet"]).risk).toBe(
      "protected"
    );
  });

  it(".vs es siempre review, nunca safe", () => {
    expect(classifyPath(".vs", DEFAULT_RULES, ["dotnet"]).risk).toBe("review");
    expect(classifyPath(".vs", DEFAULT_RULES).risk).toBe("review");
    // Aunque el usuario intente volverlo safe, el conflicto lo deja en review.
    const debilitadas = {
      ...DEFAULT_RULES,
      safe: [...DEFAULT_RULES.safe, ".vs"]
    };
    expect(classifyPath(".vs", debilitadas, ["dotnet"]).risk).toBe("review");
  });
});

describe("loader — projectRules y la invariante .vs", () => {
  it("rechaza tipos de proyecto desconocidos", async () => {
    const dir = await tempDir("repo-cleaner-dotnet-rules-");
    const file = path.join(dir, "rules.json");
    await fs.writeFile(
      file,
      JSON.stringify({ projectRules: { cobol: { safe: ["bin"] } } })
    );
    await expect(loadRules(file)).rejects.toThrow(/desconocido/);
  });

  it("rechaza patrones condicionados que chocan con protecciones", async () => {
    const dir = await tempDir("repo-cleaner-dotnet-rules-");
    const file = path.join(dir, "rules.json");
    await fs.writeFile(
      file,
      JSON.stringify({ projectRules: { dotnet: { safe: [".git"] } } })
    );
    await expect(loadRules(file)).rejects.toThrow(/protegida/);
  });

  it("mantiene .vs en review aunque el usuario lo quite de su lista", async () => {
    const dir = await tempDir("repo-cleaner-dotnet-rules-");
    const file = path.join(dir, "rules.json");
    await fs.writeFile(
      file,
      JSON.stringify({ review: ["*.zip"], safe: ["node_modules", ".vs"] })
    );
    const { rules } = await loadRules(file);
    expect(rules.review).toContain(".vs");
    expect(classifyPath(".vs", rules, ["dotnet"]).risk).toBe("review");
  });
});

describe("scanner — proyecto .NET real de prueba", () => {
  it("detecta .NET por csproj, fsproj, vbproj y sln", async () => {
    const dir = await tempDir("repo-cleaner-dotnet-detect-");
    await writeFixtureFile(dir, "App.vbproj", "<Project/>");
    expect((await detectProjectType(dir)).types).toEqual(["dotnet"]);
  });

  it("clasifica bin/obj safe y .vs review dentro de un proyecto .NET", async () => {
    const dir = await tempDir("repo-cleaner-dotnet-proj-");
    await writeFixtureFile(dir, "MiApp.csproj", "<Project/>");
    await writeFixtureFile(dir, ".gitignore", "bin/\nobj/\n");
    await writeFixtureFile(dir, "bin/Debug/net8.0/MiApp.dll", "binario");
    await writeFixtureFile(dir, "obj/project.assets.json", "{}");
    await writeFixtureFile(dir, ".vs/MiApp/config/applicationhost.config", "x");
    await writeFixtureFile(dir, "Program.cs", "class Program {}");

    const report = await scanProject(dir, testRules());
    expect(report.projectTypes).toEqual(["dotnet"]);
    const byPath = new Map(report.entries.map((e) => [e.relativePath, e]));
    expect(byPath.get("bin")?.risk).toBe("safe");
    expect(byPath.get("obj")?.risk).toBe("safe");
    expect(byPath.get(".vs")?.risk).toBe("review");
    expect(byPath.get("Program.cs")).toBeUndefined();
  });

  it("bin/obj en un proyecto Node.js nunca son safe (review si se listan)", async () => {
    const dir = await tempDir("repo-cleaner-node-bin-");
    await writeFixtureFile(dir, "package.json", '{"name":"x"}');
    await writeFixtureFile(dir, ".gitignore", "bin/\nobj/\n");
    // Contenido suficientemente grande para que el directorio desconocido
    // aflore como review (umbral de test ~1 KB).
    await writeFixtureFile(dir, "bin/herramienta.js", "x".repeat(2048));
    await writeFixtureFile(dir, "obj/datos.json", "y".repeat(2048));

    const report = await scanProject(dir, testRules());
    const byPath = new Map(report.entries.map((e) => [e.relativePath, e]));
    expect(byPath.get("bin")?.risk).toBe("review");
    expect(byPath.get("obj")?.risk).toBe("review");
    expect(report.entries.some((e) => e.risk === "safe")).toBe(false);
  });

  it("bin/obj .NET no ignorados por .gitignore se degradan a review", async () => {
    const dir = await tempDir("repo-cleaner-dotnet-nogit-");
    await writeFixtureFile(dir, "MiApp.csproj", "<Project/>");
    await writeFixtureFile(dir, ".gitignore", "node_modules/\n");
    await writeFixtureFile(dir, "bin/Debug/MiApp.dll", "binario");

    const report = await scanProject(dir, testRules());
    const bin = report.entries.find((e) => e.relativePath === "bin");
    expect(bin?.risk).toBe("review");
    expect(bin?.reason).toMatch(/gitignore/);
  });
});

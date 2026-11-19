import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyPath,
  matchNegation,
  negationUnderDirectory
} from "../src/core/rule-engine.js";
import { scanProject } from "../src/core/scanner.js";
import { DEFAULT_RULES } from "../src/rules/defaults.js";
import { loadRules } from "../src/rules/loader.js";
import type { CleanerRuleSet } from "../src/types/index.js";
import { makeFixture, testRules, writeFixtureFile } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

function withNegations(negations: string[]): CleanerRuleSet {
  return { ...DEFAULT_RULES, safeNegations: negations };
}

describe("reglas negadas — motor", () => {
  it("una negación fuerza review sobre la ruta excluida y su descendencia", () => {
    const rules = withNegations(["!dist/manifest.json"]);
    const result = classifyPath("dist/manifest.json", rules);
    expect(result.risk).toBe("review");
    expect(result.matchedRule).toBe("!dist/manifest.json");
    expect(classifyPath("dist/manifest.json/hijo", rules).risk).toBe("review");
  });

  it("la negación prevalece sobre la regla safe equivalente", () => {
    const rules = withNegations(["!node_modules/.cache/important-data"]);
    expect(classifyPath("node_modules", rules).risk).toBe("safe");
    expect(classifyPath("node_modules/.cache/important-data", rules).risk).toBe(
      "review"
    );
    expect(
      classifyPath("node_modules/.cache/important-data/x.bin", rules).risk
    ).toBe("review");
    expect(matchNegation("node_modules/.cache/important-data", rules)).toBe(
      "!node_modules/.cache/important-data"
    );
  });

  it("detecta negaciones dentro de un directorio safe (degradación)", () => {
    const rules = withNegations(["!dist/manifest.json"]);
    expect(negationUnderDirectory("dist", rules)).toBe("!dist/manifest.json");
    expect(negationUnderDirectory("node_modules", rules)).toBeUndefined();
  });

  it("soporta globs en la ruta negada", () => {
    const rules = withNegations(["!dist/*.json"]);
    expect(classifyPath("dist/manifest.json", rules).risk).toBe("review");
    expect(negationUnderDirectory("dist", rules)).toBe("!dist/*.json");
  });

  it("las negaciones NUNCA debilitan rutas protegidas", () => {
    const rules = withNegations(["!src", "!.git", "!docs"]);
    expect(classifyPath("src", rules).risk).toBe("protected");
    expect(classifyPath(".git", rules).risk).toBe("protected");
    expect(classifyPath("docs", rules).risk).toBe("protected");
    expect(classifyPath("src/index.ts", rules).risk).toBe("protected");
  });

  it("normaliza separadores de Windows en las negaciones", () => {
    const rules = withNegations(["!dist\\manifest.json"]);
    expect(classifyPath("dist/manifest.json", rules).risk).toBe("review");
  });
});

describe("reglas negadas — loader", () => {
  async function tempConfig(content: unknown): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-neg-"));
    tempDirs.push(dir);
    const file = path.join(dir, "rules.json");
    await fs.writeFile(file, JSON.stringify(content), "utf8");
    return file;
  }

  it("rechaza negaciones sin prefijo !", async () => {
    const file = await tempConfig({ safeNegations: ["dist/manifest.json"] });
    await expect(loadRules(file)).rejects.toThrow(/empezar por "!"/);
  });

  it("rechaza negaciones con .. o absolutas", async () => {
    const escape = await tempConfig({ safeNegations: ["!../fuera"] });
    await expect(loadRules(escape)).rejects.toThrow(/\.\./);
    const abs = await tempConfig({ safeNegations: ["!C:/Windows"] });
    await expect(loadRules(abs)).rejects.toThrow(/absoluta/);
    const root = await tempConfig({ safeNegations: ["!/etc"] });
    await expect(loadRules(root)).rejects.toThrow(/absoluta/);
  });

  it("carga negaciones válidas y las conserva", async () => {
    const file = await tempConfig({
      safeNegations: ["!dist/manifest.json", "!dist/manifest.json"]
    });
    const { rules } = await loadRules(file);
    expect(rules.safeNegations).toEqual(["!dist/manifest.json"]);
  });
});

describe("reglas negadas — scanner", () => {
  it("degrada a review el directorio safe que contiene una exclusión", async () => {
    const root = await makeFixture();
    tempDirs.push(root);
    const target = path.join(root, "proj-node");
    await writeFixtureFile(target, "dist/manifest.json", '{"v":1}');

    const rules: CleanerRuleSet = {
      ...testRules(),
      safeNegations: ["!dist/manifest.json"]
    };
    const report = await scanProject(target, rules);
    const dist = report.entries.find((e) => e.relativePath === "dist");
    expect(dist?.risk).toBe("review");
    expect(dist?.reason).toMatch(/negación/);
    const excluded = report.entries.find(
      (e) => e.relativePath === "dist/manifest.json"
    );
    expect(excluded?.risk).toBe("review");
    expect(excluded?.matchedRule).toBe("!dist/manifest.json");
    // node_modules sigue siendo safe (sin negaciones dentro).
    const nm = report.entries.find((e) => e.relativePath === "node_modules");
    expect(nm?.risk).toBe("safe");
  });
});

describe("negaciones por tipo de proyecto (fase 5)", () => {
  function dotnetNegations(): CleanerRuleSet {
    return {
      ...DEFAULT_RULES,
      projectRules: {
        ...DEFAULT_RULES.projectRules,
        dotnet: {
          safe: ["bin", "obj"],
          safeNegations: ["!obj/project.assets.json"]
        }
      }
    };
  }

  it("solo aplican con el tipo detectado", () => {
    const rules = dotnetNegations();
    expect(matchNegation("obj/project.assets.json", rules, ["dotnet"])).toBe(
      "!obj/project.assets.json"
    );
    expect(matchNegation("obj/project.assets.json", rules)).toBeUndefined();
    expect(
      classifyPath("obj/project.assets.json", rules, ["dotnet"]).risk
    ).toBe("review");
    expect(classifyPath("obj", rules, ["dotnet"]).risk).toBe("safe");
    expect(negationUnderDirectory("obj", rules, ["dotnet"])).toBe(
      "!obj/project.assets.json"
    );
    expect(negationUnderDirectory("obj", rules)).toBeUndefined();
  });

  it("nunca debilitan protegidos aunque sean del tipo detectado", () => {
    const rules: CleanerRuleSet = {
      ...DEFAULT_RULES,
      projectRules: {
        dotnet: { safe: ["bin", "obj"], safeNegations: ["!.git", "!src"] }
      }
    };
    expect(classifyPath(".git", rules, ["dotnet"]).risk).toBe("protected");
    expect(classifyPath("src", rules, ["dotnet"]).risk).toBe("protected");
  });

  it("el scanner degrada el directorio safe con negación del tipo", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-cleaner-negdot-")
    );
    tempDirs.push(dir);
    await writeFixtureFile(dir, "MiApp.csproj", "<Project/>");
    await writeFixtureFile(dir, ".gitignore", "bin/\nobj/\n");
    await writeFixtureFile(dir, "obj/project.assets.json", "{}");
    await writeFixtureFile(dir, "obj/otra.cs", "x");
    const report = await scanProject(dir, dotnetNegations());
    const obj = report.entries.find((e) => e.relativePath === "obj");
    expect(obj?.risk).toBe("review");
    expect(obj?.reason).toMatch(/negación/);
    const excluded = report.entries.find(
      (e) => e.relativePath === "obj/project.assets.json"
    );
    expect(excluded?.risk).toBe("review");
  });

  it("loader: alias node y validación de negaciones por tipo", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-cleaner-negload-")
    );
    tempDirs.push(dir);
    const file = path.join(dir, "rules.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        projectRules: { node: { safe: [".next"], safeNegations: ["!dist/x"] } }
      }),
      "utf8"
    );
    const { rules } = await loadRules(file);
    expect(rules.projectRules?.nodejs?.safe).toEqual([".next"]);
    expect(rules.projectRules?.nodejs?.safeNegations).toEqual(["!dist/x"]);

    const bad = path.join(dir, "bad.json");
    await fs.writeFile(
      bad,
      JSON.stringify({
        projectRules: { dotnet: { safeNegations: ["!../escape"] } }
      }),
      "utf8"
    );
    await expect(loadRules(bad)).rejects.toThrow(/\.\./);
  });
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadRules } from "../src/rules/loader.js";
import { DEFAULT_RULES } from "../src/rules/defaults.js";

const tempDirs: string[] = [];

async function tempConfig(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-rules-"));
  tempDirs.push(dir);
  const file = path.join(dir, "rules.json");
  await fs.writeFile(file, content, "utf8");
  return file;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("loadRules", () => {
  it("carga config/rules.json del repositorio y coincide con las reglas internas", async () => {
    const repoConfig = fileURLToPath(
      new URL("../config/rules.json", import.meta.url)
    );
    const { rules, source } = await loadRules(repoConfig);
    expect(source).toBe(repoConfig);
    expect(rules).toEqual(DEFAULT_RULES);
  });

  it("usa las reglas internas si no existe el archivo por defecto", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-vacio-"));
    tempDirs.push(dir);
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const { rules, source } = await loadRules();
      expect(rules).toEqual(DEFAULT_RULES);
      expect(source).toContain("por defecto");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("falla si una ruta explícita no existe", async () => {
    await expect(
      loadRules(path.join(os.tmpdir(), "repo-cleaner-inexistente.json"))
    ).rejects.toThrow(/No existe/);
  });

  it("fusiona defaults parciales y conserva las protecciones internas", async () => {
    const file = await tempConfig(
      JSON.stringify({
        version: 1,
        defaults: { maxDepth: 3 },
        safe: ["node_modules", "dist"],
        protected: ["mis-datos"]
      })
    );
    const { rules } = await loadRules(file);
    expect(rules.defaults.maxDepth).toBe(3);
    expect(rules.defaults.useTrash).toBe(true);
    expect(rules.safe).toEqual(["node_modules", "dist"]);
    expect(rules.protected).toContain("mis-datos");
    expect(rules.protected).toContain(".git");
    expect(rules.protected).toContain(".env");
  });

  it("rechaza JSON inválido", async () => {
    const file = await tempConfig("{ roto");
    await expect(loadRules(file)).rejects.toThrow(/JSON inválido/);
  });

  it("rechaza versiones no soportadas", async () => {
    const file = await tempConfig(JSON.stringify({ version: 99 }));
    await expect(loadRules(file)).rejects.toThrow(/versión no soportada/);
  });

  it("rechaza tipos incorrectos en defaults", async () => {
    const file = await tempConfig(
      JSON.stringify({ defaults: { maxDepth: "mucho" } })
    );
    await expect(loadRules(file)).rejects.toThrow(/maxDepth/);
  });

  it("rechaza patrones con .. o rutas absolutas", async () => {
    const escape = await tempConfig(JSON.stringify({ safe: ["../fuera"] }));
    await expect(loadRules(escape)).rejects.toThrow(/\.\./);
    const abs = await tempConfig(JSON.stringify({ safe: ["C:/Windows"] }));
    await expect(loadRules(abs)).rejects.toThrow(/absolutas/);
  });

  it("rechaza patrones safe que chocan con rutas protegidas", async () => {
    const file = await tempConfig(JSON.stringify({ safe: [".git"] }));
    await expect(loadRules(file)).rejects.toThrow(/protegida/);
    const pem = await tempConfig(JSON.stringify({ safe: ["*.pem"] }));
    await expect(loadRules(pem)).rejects.toThrow(/protegida/);
  });
});

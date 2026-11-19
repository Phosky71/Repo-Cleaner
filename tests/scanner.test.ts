import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectProjectType,
  scanProject,
  scanRoot
} from "../src/core/scanner.js";
import { DEFAULT_RULES } from "../src/rules/defaults.js";
import {
  listFiles,
  makeFixture,
  testRules,
  writeFixtureFile
} from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function fixture(): Promise<string> {
  const root = await makeFixture();
  tempDirs.push(root);
  return root;
}

describe("detectProjectType", () => {
  it("detecta TypeScript + Node.js con prioridad de tipos", async () => {
    const root = await fixture();
    const detection = await detectProjectType(path.join(root, "proj-node"));
    expect(detection.types).toEqual(["typescript", "nodejs"]);
    expect(detection.markers).toContain("package.json");
    expect(detection.markers).toContain("tsconfig.json");
  });

  it("detecta Python, Go y proyectos desconocidos", async () => {
    const root = await fixture();
    expect((await detectProjectType(path.join(root, "proj-py"))).types).toEqual(
      ["python"]
    );
    expect(
      (await detectProjectType(path.join(root, "grupo/proj-go"))).types
    ).toEqual(["go"]);
    expect(
      (await detectProjectType(path.join(root, "no-proyecto"))).types
    ).toEqual(["unknown"]);
  });
});

describe("scanRoot — descubrimiento de proyectos", () => {
  it("encuentra proyectos en subcarpetas, incluidos anidados", async () => {
    const root = await fixture();
    const report = await scanRoot(root, testRules());
    const relatives = report.projects.map((p) => p.relativePath).sort();
    expect(relatives).toEqual(["grupo/proj-go", "proj-node", "proj-py"]);
    expect(report.summary.projectCount).toBe(3);
  });

  it("no crea proyectos dentro de node_modules ni carpetas sin marcadores", async () => {
    const root = await fixture();
    const report = await scanRoot(root, testRules());
    const paths = report.projects.map((p) => p.path);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.endsWith("no-proyecto"))).toBe(false);
  });

  it("si la raíz es un proyecto, la analiza como único proyecto", async () => {
    const root = await fixture();
    const report = await scanRoot(path.join(root, "proj-node"), testRules());
    expect(report.projects).toHaveLength(1);
    expect(report.projects[0]?.relativePath).toBe(".");
  });

  it("falla con una ruta inexistente", async () => {
    await expect(
      scanRoot(path.join(os.tmpdir(), "repo-cleaner-no-existe"), DEFAULT_RULES)
    ).rejects.toThrow(/no existe/);
  });

  it("expone tamaño, fecha y presencia de artefactos por proyecto", async () => {
    const root = await fixture();
    const report = await scanRoot(root, testRules());
    const node = report.projects.find((p) => p.name === "proj-node");
    expect(node).toBeDefined();
    expect(node?.sizeBytes).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(node?.lastModified ?? ""))).toBe(false);
    expect(node?.hasArtifacts).toBe(true);
    expect(node?.artifacts.safeCount).toBeGreaterThanOrEqual(3);
  });
});

describe("scanProject — clasificación de artefactos", () => {
  it("marca node_modules, dist y *.log como safe (ignorados por .gitignore)", async () => {
    const root = await fixture();
    const report = await scanProject(path.join(root, "proj-node"), testRules());
    const byPath = new Map(report.entries.map((e) => [e.relativePath, e]));
    expect(byPath.get("node_modules")?.risk).toBe("safe");
    expect(byPath.get("dist")?.risk).toBe("safe");
    expect(byPath.get("debug.log")?.risk).toBe("safe");
    expect(byPath.get("node_modules")?.sizeBytes).toBeGreaterThan(0);
  });

  it("nunca marca .git, .env ni src como eliminables", async () => {
    const root = await fixture();
    const report = await scanProject(path.join(root, "proj-node"), testRules());
    for (const entry of report.entries) {
      if (
        entry.relativePath === ".git" ||
        entry.relativePath === ".env" ||
        entry.relativePath === "src"
      ) {
        expect(entry.risk).toBe("protected");
      }
    }
    expect(
      report.entries.some(
        (e) => e.risk === "safe" && e.relativePath.startsWith(".git")
      )
    ).toBe(false);
  });

  it("clasifica binarios como review y archivos grandes desconocidos como review", async () => {
    const root = await fixture();
    const report = await scanProject(path.join(root, "proj-node"), testRules());
    expect(
      report.entries.find((e) => e.relativePath === "datos.bin")?.risk
    ).toBe("review");

    const suelto = await scanProject(
      path.join(root, "no-proyecto"),
      testRules()
    );
    const grande = suelto.entries.find((e) => e.relativePath === "grande.dat");
    expect(grande?.risk).toBe("review");
    expect(grande?.reason).toMatch(/grande/);
  });

  it("degrada a review un patrón safe no ignorado por .gitignore", async () => {
    const root = await fixture();
    // "out" es safe por regla, pero este .gitignore no lo lista.
    await writeFixtureFile(root, "proj-node/out/bundle.js", "x");
    const report = await scanProject(path.join(root, "proj-node"), testRules());
    const out = report.entries.find((e) => e.relativePath === "out");
    expect(out?.risk).toBe("review");
    expect(out?.reason).toMatch(/gitignore/);
  });

  it("detecta __pycache__ y .venv en proyectos Python", async () => {
    const root = await fixture();
    const report = await scanProject(path.join(root, "proj-py"), testRules());
    const byPath = new Map(report.entries.map((e) => [e.relativePath, e]));
    expect(byPath.get("__pycache__")?.risk).toBe("safe");
    expect(byPath.get(".venv")?.risk).toBe("safe");
  });

  it("los totales por riesgo no solapan bytes (atribución por ancestro)", async () => {
    const root = await fixture();
    // Directorio grande desconocido que contiene un node_modules anidado.
    await writeFixtureFile(
      root,
      "proj-node/datos-grandes/node_modules/paquete/index.js",
      "x".repeat(4096)
    );
    await writeFixtureFile(
      root,
      "proj-node/datos-grandes/archivo.dat",
      "y".repeat(4096)
    );
    const report = await scanProject(path.join(root, "proj-node"), testRules());
    const grande = report.entries.find(
      (e) => e.relativePath === "datos-grandes"
    );
    const nested = report.entries.find(
      (e) => e.relativePath === "datos-grandes/node_modules"
    );
    expect(grande?.risk).toBe("review");
    expect(nested?.risk).toBe("safe");
    const s = report.summary;
    expect(s.safeBytes + s.reviewBytes + s.protectedBytes).toBeLessThanOrEqual(
      s.totalSizeBytes
    );
    // El node_modules anidado no se cuenta dentro de los bytes review.
    expect(s.reviewBytes).toBeLessThan(grande?.sizeBytes ?? 0);
  });

  it("todas las rutas detectadas están dentro del objetivo", async () => {
    const root = await fixture();
    const target = path.join(root, "proj-node");
    const report = await scanProject(target, testRules());
    for (const entry of report.entries) {
      expect(entry.absolutePath.startsWith(target + path.sep)).toBe(true);
      expect(entry.relativePath.split("/")).not.toContain("..");
    }
  });

  it("no sigue junctions/symlinks hacia fuera del objetivo", async () => {
    const root = await fixture();
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "repo-cleaner-out-")
    );
    tempDirs.push(outside);
    await writeFixtureFile(outside, "secreto.txt", "no tocar");
    const linkPath = path.join(root, "proj-node", "escape");
    let linked = false;
    try {
      await fs.symlink(outside, linkPath, "junction");
      linked = true;
    } catch {
      // Sin privilegios para crear junctions: se omite esta comprobación.
    }
    const report = await scanProject(path.join(root, "proj-node"), testRules());
    expect(
      report.entries.some((e) => e.relativePath.startsWith("escape"))
    ).toBe(false);
    if (linked) {
      // El contenido enlazado no debe contar en el tamaño del proyecto.
      const sizes = report.summary.totalSizeBytes;
      expect(sizes).toBeLessThan(1024 * 1024);
    }
  });
});

describe("scanRoot — garantías de solo lectura", () => {
  it("no modifica ni elimina ningún archivo del árbol escaneado", async () => {
    const root = await fixture();
    const before = await listFiles(root);
    await scanRoot(root, testRules());
    const after = await listFiles(root);
    expect(after).toEqual(before);
  });
});

import { describe, expect, it } from "vitest";
import { classifyPath } from "../src/core/rule-engine.js";
import { DEFAULT_RULES } from "../src/rules/defaults.js";
import type { CleanerRuleSet } from "../src/types/index.js";

const rules = DEFAULT_RULES;

describe("classifyPath — protegidos (prioridad máxima)", () => {
  it("protege .git y todo su contenido", () => {
    expect(classifyPath(".git", rules).risk).toBe("protected");
    expect(classifyPath(".git/config", rules).risk).toBe("protected");
    expect(classifyPath("paquete/.git/HEAD", rules).risk).toBe("protected");
  });

  it("protege código fuente, tests y documentación aunque coincidan con safe", () => {
    expect(classifyPath("src", rules).risk).toBe("protected");
    expect(classifyPath("src/dist", rules).risk).toBe("protected");
    expect(classifyPath("tests/node_modules", rules).risk).toBe("protected");
    expect(classifyPath("docs/build", rules).risk).toBe("protected");
  });

  it("protege secretos, claves y certificados", () => {
    expect(classifyPath(".env", rules).risk).toBe("protected");
    expect(classifyPath(".env.local", rules).risk).toBe("protected");
    expect(classifyPath(".env.production", rules).risk).toBe("protected");
    expect(classifyPath("certs/servidor.pem", rules).risk).toBe("protected");
    expect(classifyPath("privada.key", rules).risk).toBe("protected");
    expect(classifyPath("almacen.p12", rules).risk).toBe("protected");
  });

  it("protege bases de datos y backups", () => {
    expect(classifyPath("datos.sqlite", rules).risk).toBe("protected");
    expect(classifyPath("copia.dump", rules).risk).toBe("protected");
    expect(classifyPath("backups", rules).risk).toBe("protected");
    expect(classifyPath("app.bak", rules).risk).toBe("protected");
  });

  it("Thumbs.db es safe (caché) y no choca con las reglas de bases de datos", () => {
    expect(classifyPath("Thumbs.db", rules).risk).toBe("safe");
  });
});

describe("classifyPath — safe", () => {
  it("detecta artefactos regenerables conocidos a cualquier profundidad", () => {
    expect(classifyPath("node_modules", rules).risk).toBe("safe");
    expect(classifyPath("packages/web/node_modules", rules).risk).toBe("safe");
    expect(classifyPath("dist", rules).risk).toBe("safe");
    expect(classifyPath(".next", rules).risk).toBe("safe");
    expect(classifyPath("target", rules).risk).toBe("safe");
    expect(classifyPath("__pycache__", rules).risk).toBe("safe");
    expect(classifyPath(".venv", rules).risk).toBe("safe");
  });

  it("soporta patrones glob de archivo", () => {
    expect(classifyPath("debug.log", rules).risk).toBe("safe");
    expect(classifyPath("logs/error.log", rules).risk).toBe("safe");
    expect(classifyPath("tsconfig.tsbuildinfo", rules).risk).toBe("safe");
    expect(classifyPath("sesion.tmp", rules).risk).toBe("safe");
    expect(classifyPath(".DS_Store", rules).risk).toBe("safe");
  });

  it("normaliza separadores de Windows", () => {
    expect(classifyPath("packages\\web\\node_modules", rules).risk).toBe(
      "safe"
    );
    expect(classifyPath("src\\index.ts", rules).risk).toBe("protected");
  });
});

describe("classifyPath — review y ambigüedad", () => {
  it("clasifica binarios y archivos comprimidos como review", () => {
    expect(classifyPath("datos.bin", rules).risk).toBe("review");
    expect(classifyPath("paquete.zip", rules).risk).toBe("review");
    expect(classifyPath("instalador.exe", rules).risk).toBe("review");
  });

  it("lo desconocido nunca es safe", () => {
    const result = classifyPath("cosas/varias.dat", rules);
    expect(result.risk).toBe("review");
    expect(result.matchedRule).toBeUndefined();
  });

  it("un conflicto safe+review se resuelve como review", () => {
    const custom: CleanerRuleSet = {
      ...rules,
      safe: [...rules.safe, "*.tmp"],
      review: [...rules.review, "*.tmp"]
    };
    expect(classifyPath("algo.tmp", custom).risk).toBe("review");
  });

  it("rechaza rutas con escape .. o absolutas como protegidas", () => {
    expect(classifyPath("../fuera", rules).risk).toBe("protected");
    expect(classifyPath("a/../../fuera", rules).risk).toBe("protected");
    expect(classifyPath("C:/Windows/system32", rules).risk).toBe("protected");
    expect(classifyPath("/etc/passwd", rules).risk).toBe("protected");
    expect(classifyPath("", rules).risk).toBe("protected");
  });
});

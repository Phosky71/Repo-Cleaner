import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeToDelete } from "../src/core/safety.js";
import { DEFAULT_RULES } from "../src/rules/defaults.js";
import type { CleanerRuleSet } from "../src/types/index.js";

const target = path.resolve("C:/Trabajo/ProyectoEjemplo");

describe("assertSafeToDelete", () => {
  it("acepta un artefacto safe dentro del objetivo", () => {
    expect(() =>
      assertSafeToDelete(
        path.join(target, "node_modules"),
        target,
        DEFAULT_RULES
      )
    ).not.toThrow();
    expect(() =>
      assertSafeToDelete(path.join(target, "dist"), target, DEFAULT_RULES)
    ).not.toThrow();
  });

  it("rechaza el propio directorio objetivo", () => {
    expect(() => assertSafeToDelete(target, target, DEFAULT_RULES)).toThrow(
      /objetivo/
    );
  });

  it("rechaza rutas fuera del objetivo", () => {
    expect(() =>
      assertSafeToDelete(
        path.resolve("C:/Trabajo/OtroProyecto/dist"),
        target,
        DEFAULT_RULES
      )
    ).toThrow(/fuera/);
  });

  it("rechaza segmentos .. aunque apunten dentro", () => {
    // Sin path.join: debe conservarse el ".." literal en la ruta recibida.
    const raw = `${target}${path.sep}src${path.sep}..${path.sep}node_modules`;
    expect(() => assertSafeToDelete(raw, target, DEFAULT_RULES)).toThrow(
      /\.\./
    );
  });

  it("rechaza .git, secretos y código fuente", () => {
    expect(() =>
      assertSafeToDelete(path.join(target, ".git"), target, DEFAULT_RULES)
    ).toThrow(/protected/);
    expect(() =>
      assertSafeToDelete(path.join(target, ".env"), target, DEFAULT_RULES)
    ).toThrow(/protected/);
    expect(() =>
      assertSafeToDelete(path.join(target, "src"), target, DEFAULT_RULES)
    ).toThrow(/protected/);
    expect(() =>
      assertSafeToDelete(path.join(target, "clave.pem"), target, DEFAULT_RULES)
    ).toThrow(/protected/);
  });

  it("rechaza elementos review", () => {
    expect(() =>
      assertSafeToDelete(path.join(target, "datos.bin"), target, DEFAULT_RULES)
    ).toThrow(/review/);
  });

  it("permite review SOLO con selección humana explícita (allowReview)", () => {
    expect(() =>
      assertSafeToDelete(
        path.join(target, "datos.bin"),
        target,
        DEFAULT_RULES,
        undefined,
        {
          allowReview: true
        }
      )
    ).not.toThrow();
    // protected sigue bloqueado aunque se active allowReview.
    expect(() =>
      assertSafeToDelete(
        path.join(target, ".git"),
        target,
        DEFAULT_RULES,
        undefined,
        {
          allowReview: true
        }
      )
    ).toThrow(/protected/);
    expect(() =>
      assertSafeToDelete(
        path.join(target, ".env"),
        target,
        DEFAULT_RULES,
        undefined,
        {
          allowReview: true
        }
      )
    ).toThrow(/protected/);
  });

  it("bin/obj .NET: safe solo con tipo detectado; review sin él", () => {
    expect(() =>
      assertSafeToDelete(path.join(target, "bin"), target, DEFAULT_RULES, [
        "dotnet"
      ])
    ).not.toThrow();
    expect(() =>
      assertSafeToDelete(path.join(target, "bin"), target, DEFAULT_RULES)
    ).toThrow(/review/);
  });

  it("mantiene las invariantes aunque el usuario debilite las reglas", () => {
    const weakened: CleanerRuleSet = {
      ...DEFAULT_RULES,
      protected: [],
      safe: [...DEFAULT_RULES.safe, ".git", ".env", "src"]
    };
    expect(() =>
      assertSafeToDelete(path.join(target, ".git"), target, weakened)
    ).toThrow(/invariante/);
    expect(() =>
      assertSafeToDelete(path.join(target, ".env"), target, weakened)
    ).toThrow(/invariante/);
    expect(() =>
      assertSafeToDelete(path.join(target, "src"), target, weakened)
    ).toThrow(/invariante/);
  });
});

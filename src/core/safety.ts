import path from "node:path";
import type { CleanerRuleSet, ProjectType } from "../types/index.js";
import { DEFAULT_RULES } from "../rules/defaults.js";
import { classifyPath } from "./rule-engine.js";

export interface SafetyOptions {
  /**
   * Permite elementos `review` SOLO cuando el humano los ha seleccionado
   * explícitamente (selección individual o categoría + confirmación).
   * Por defecto el guard sigue aceptando únicamente `safe`.
   */
  allowReview?: boolean;
}

/**
 * Safety Guard: última línea de defensa antes de cualquier eliminación.
 * Se aplica SIEMPRE, incluso en modo permanente o con `--yes`.
 *
 * Garantías:
 * - Nunca la ruta objetivo ni rutas fuera de ella.
 * - Nunca segmentos `..` (escape del target).
 * - Solo elementos `safe`, o `review` con selección humana explícita.
 * - Nunca `protected`, ni siquiera con allowReview.
 * - Invariantes innegociables: aunque el usuario debilite `config/rules.json`,
 *   se vuelve a comprobar contra las reglas protegidas internas (.git, .env,
 *   claves, certificados, código fuente, tests, documentación, backups...).
 */
export function assertSafeToDelete(
  absolutePath: string,
  target: string,
  rules: CleanerRuleSet,
  projectTypes?: ProjectType[],
  options: SafetyOptions = {}
): void {
  if (absolutePath.split(/[\\/]/).includes("..")) {
    throw new Error(
      `Bloqueado por seguridad: la ruta contiene "..": ${absolutePath}`
    );
  }

  const absTarget = path.resolve(target);
  const absPath = path.resolve(absolutePath);
  const relative = path.relative(absTarget, absPath);

  if (relative === "") {
    throw new Error(
      `Bloqueado por seguridad: no se puede eliminar el directorio objetivo (${absTarget})`
    );
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Bloqueado por seguridad: ${absPath} está fuera del objetivo ${absTarget}`
    );
  }

  const classification = classifyPath(relative, rules, projectTypes);
  const allowed =
    classification.risk === "safe" ||
    (classification.risk === "review" && options.allowReview === true);
  if (!allowed) {
    throw new Error(
      `Bloqueado por seguridad: ${relative} está clasificado como ${classification.risk} (${classification.reason})`
    );
  }

  const invariant = classifyPath(relative, DEFAULT_RULES, projectTypes);
  if (invariant.risk === "protected") {
    throw new Error(
      `Bloqueado por seguridad (invariante): ${relative} (${invariant.reason})`
    );
  }
}

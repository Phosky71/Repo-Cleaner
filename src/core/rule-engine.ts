import picomatch from "picomatch";
import type { CleanerRuleSet, ProjectType, Risk } from "../types/index.js";

export interface ClassificationResult {
  risk: Risk;
  reason: string;
  matchedRule?: string;
}

/** En Windows el sistema de archivos no distingue mayúsculas. */
const NOCASE = process.platform === "win32";

function isGlobPattern(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

function sameName(a: string, b: string): boolean {
  return NOCASE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Los patrones se aplican al nombre final (basename) de la ruta. */
function matchesName(name: string, pattern: string): boolean {
  if (isGlobPattern(pattern)) {
    return picomatch.isMatch(name, pattern, { dot: true, nocase: NOCASE });
  }
  return sameName(name, pattern);
}

function findProtected(
  segments: string[],
  name: string,
  patterns: string[]
): string | undefined {
  return patterns.find((pattern) =>
    isGlobPattern(pattern)
      ? matchesName(name, pattern)
      : segments.some((segment) => sameName(segment, pattern))
  );
}

function normalizeRelative(input: string): string {
  return input
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

function negationPattern(raw: string): string {
  return normalizeRelative(raw.replace(/^!/, ""));
}

/**
 * Negaciones (`safeNegations`, con prefijo "!"). Se aplican a la ruta
 * relativa completa. Una coincidencia (o un ancestro literal coincidente)
 * fuerza review; nunca puede debilitar una ruta protegida.
 * Devuelve la regla original "!patrón" o undefined.
 */
export function matchNegation(
  relativePath: string,
  rules: CleanerRuleSet,
  projectTypes?: ProjectType[]
): string | undefined {
  const normalized = normalizeRelative(relativePath);
  if (normalized.length === 0) return undefined;
  const negationLists = [
    rules.safeNegations ?? [],
    ...(projectTypes ?? []).map(
      (type) => rules.projectRules?.[type]?.safeNegations ?? []
    )
  ];
  for (const raw of negationLists.flat()) {
    const pattern = negationPattern(raw);
    if (pattern.length === 0) continue;
    if (isGlobPattern(pattern)) {
      if (
        picomatch.isMatch(normalized, pattern, { dot: true, nocase: NOCASE })
      ) {
        return raw;
      }
    } else if (
      sameName(normalized, pattern) ||
      (NOCASE
        ? normalized.toLowerCase().startsWith(pattern.toLowerCase() + "/")
        : normalized.startsWith(pattern + "/"))
    ) {
      return raw;
    }
  }
  return undefined;
}

/**
 * Indica si una negación vive DENTRO de un directorio (prefijo literal).
 * Sirve para degradar a review un directorio safe que contiene exclusiones.
 * Las negaciones que empiezan por comodín (p. ej. "!**\/x") no son
 * localizables: solo se aplican a elementos visitados por el scanner.
 */
export function negationUnderDirectory(
  dirRelativePath: string,
  rules: CleanerRuleSet,
  projectTypes?: ProjectType[]
): string | undefined {
  const dir = normalizeRelative(dirRelativePath);
  const lists = [
    rules.safeNegations ?? [],
    ...(projectTypes ?? []).map(
      (type) => rules.projectRules?.[type]?.safeNegations ?? []
    )
  ];
  for (const list of lists) {
    for (const raw of list) {
      const pattern = negationPattern(raw);
      const literal: string[] = [];
      for (const segment of pattern.split("/")) {
        if (isGlobPattern(segment)) break;
        literal.push(segment);
      }
      const prefix = literal.join("/");
      if (prefix.length === 0) continue;
      const under = NOCASE
        ? prefix.toLowerCase().startsWith(dir.toLowerCase() + "/")
        : prefix.startsWith(dir + "/");
      if (sameName(prefix, dir) || under) {
        return raw;
      }
    }
  }
  return undefined;
}

/**
 * Motor de reglas. Orden de prioridad:
 * 1. Rutas inválidas o con escape (`..`, absolutas) -> protected.
 * 2. Reglas protegidas (globales y del tipo de proyecto detectado).
 * 3. Conflicto safe + review -> review (nunca safe si hay ambigüedad).
 * 4. Reglas de revisión.
 * 5. Reglas seguras (globales + condicionadas al tipo de proyecto).
 * 6. Sin regla conocida -> review (jamás safe por defecto).
 *
 * `projectTypes` activa las reglas condicionadas (`projectRules`). Sin tipos
 * detectados, patrones como `bin`/`obj` (.NET) quedan como review: ambigüedad.
 */
export function classifyPath(
  relativePath: string,
  rules: CleanerRuleSet,
  projectTypes?: ProjectType[]
): ClassificationResult {
  const normalized = normalizeRelative(relativePath);
  const segments = normalized.split("/").filter((s) => s.length > 0);

  if (
    segments.length === 0 ||
    segments.includes("..") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    return {
      risk: "protected",
      reason: "Ruta inválida, absoluta o con escape (..): nunca eliminable"
    };
  }

  const name = segments[segments.length - 1] ?? "";
  const types = projectTypes ?? [];

  const globalProtected = findProtected(segments, name, rules.protected);
  if (globalProtected) {
    return {
      risk: "protected",
      reason: `Ruta protegida por regla: ${globalProtected}`,
      matchedRule: globalProtected
    };
  }
  for (const type of types) {
    const local = rules.projectRules?.[type]?.protected;
    if (!local) continue;
    const hit = findProtected(segments, name, local);
    if (hit) {
      return {
        risk: "protected",
        reason: `Ruta protegida en proyecto ${type}: ${hit}`,
        matchedRule: hit
      };
    }
  }

  // Negaciones: prioridad sobre safe, nunca sobre protected.
  const negated = matchNegation(normalized, rules, types);
  if (negated) {
    return {
      risk: "review",
      reason: `Excluido por regla negada: ${negated}`,
      matchedRule: negated
    };
  }

  const safeMatches: Array<{ pattern: string; scope: string }> = [];
  const reviewMatches: Array<{ pattern: string; scope: string }> = [];
  for (const pattern of rules.safe) {
    if (matchesName(name, pattern)) {
      safeMatches.push({ pattern, scope: "global" });
    }
  }
  for (const pattern of rules.review) {
    if (matchesName(name, pattern)) {
      reviewMatches.push({ pattern, scope: "global" });
    }
  }
  for (const type of types) {
    const local = rules.projectRules?.[type];
    if (!local) continue;
    for (const pattern of local.safe ?? []) {
      if (matchesName(name, pattern)) {
        safeMatches.push({ pattern, scope: type });
      }
    }
    for (const pattern of local.review ?? []) {
      if (matchesName(name, pattern)) {
        reviewMatches.push({ pattern, scope: type });
      }
    }
  }

  const safeMatch = safeMatches[0];
  const reviewMatch = reviewMatches[0];

  if (safeMatch && reviewMatch) {
    return {
      risk: "review",
      reason: `Conflicto entre regla segura (${safeMatch.pattern}) y de revisión (${reviewMatch.pattern}): revisar`,
      matchedRule: reviewMatch.pattern
    };
  }
  if (reviewMatch) {
    return {
      risk: "review",
      reason: `Requiere revisión: coincide con ${reviewMatch.pattern}`,
      matchedRule: reviewMatch.pattern
    };
  }
  if (safeMatch) {
    const scopeLabel =
      safeMatch.scope === "global" ? "" : ` en proyecto ${safeMatch.scope}`;
    return {
      risk: "safe",
      reason: `Regenerable${scopeLabel}: coincide con ${safeMatch.pattern}`,
      matchedRule: safeMatch.pattern
    };
  }

  return {
    risk: "review",
    reason: "Sin regla conocida: no eliminar sin revisión humana"
  };
}

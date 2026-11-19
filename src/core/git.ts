import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { GitVerification } from "../types/index.js";

/**
 * Verificación posterior a la limpieza: `git status --short` (solo lectura).
 * Detecta ficheros versionados eliminados inesperadamente.
 * Nunca ejecuta git clean ni ningún comando destructivo.
 */
export function verifyGitStatus(target: string): GitVerification {
  const gitDir = path.join(target, ".git");
  if (!existsSync(gitDir)) {
    return {
      available: false,
      output: "El objetivo no es un repositorio Git: verificación omitida.",
      deletedTracked: []
    };
  }

  const result = spawnSync("git", ["status", "--short"], {
    cwd: target,
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true
  });

  if (result.error || result.status !== 0) {
    return {
      available: false,
      output:
        result.error?.message ??
        (result.stderr || "git status no pudo ejecutarse."),
      deletedTracked: []
    };
  }

  const output = result.stdout ?? "";
  // XY ruta: X o Y === "D" indica eliminación de un fichero versionado.
  const deletedTracked = output
    .split(/\r?\n/)
    .filter((line) => line.length > 3 && /^(?:D.|.D)/.test(line))
    .map((line) => line.slice(3));

  return { available: true, output, deletedTracked };
}

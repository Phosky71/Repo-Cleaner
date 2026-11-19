import { promises as fs } from "node:fs";
import path from "node:path";

/** Error de API con código HTTP; nunca expone stack traces al cliente. */
export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 410 | 500,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function assertNoEscape(raw: string): void {
  if (raw.split(/[\\/]/).includes("..")) {
    throw new ApiError(
      400,
      'La ruta no puede contener "..". Usa rutas dentro de la raíz autorizada, sin segmentos de escape.'
    );
  }
}

/**
 * Valida que una ruta recibida por la API:
 * - es un string no vacío,
 * - no contiene segmentos "..",
 * - queda DENTRO de la raíz autorizada (inclusive),
 * - existe y es un directorio.
 * Devuelve la ruta absoluta validada.
 */
export async function validateDirectoryWithinRoot(
  raw: unknown,
  allowedRoot: string,
  label: string
): Promise<string> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ApiError(
      400,
      `"${label}" es obligatorio y debe ser texto. Introduce una ruta válida.`
    );
  }
  assertNoEscape(raw);
  const resolved = path.resolve(raw);
  const relative = path.relative(allowedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ApiError(
      400,
      `"${label}" está fuera de la raíz autorizada (${allowedRoot}). Vuelve a seleccionar una ruta dentro de ella.`
    );
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) {
    throw new ApiError(
      400,
      `La ruta no existe: ${resolved}. Comprueba que esté bien escrita y sea accesible.`
    );
  }
  if (!stat.isDirectory()) {
    throw new ApiError(
      400,
      `La ruta no es un directorio: ${resolved}. Selecciona una carpeta, no un archivo.`
    );
  }
  return resolved;
}

/** Rutas relativas seleccionadas por el usuario (checkboxes de la UI). */
export function validateSelectors(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(
      400,
      "selectedRelativePaths debe ser un array no vacío de rutas relativas"
    );
  }
  if (value.length > 5000) {
    throw new ApiError(400, "Demasiados elementos seleccionados (máx. 5000)");
  }
  return value.map((raw) => {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new ApiError(
        400,
        "La selección contiene una ruta vacía o no textual"
      );
    }
    const normalized = raw.replace(/\\/g, "/").replace(/\/$/, "");
    if (normalized.split("/").includes("..")) {
      throw new ApiError(400, `La selección no puede contener "..": ${raw}`);
    }
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
      throw new ApiError(
        400,
        `La selección debe ser relativa al proyecto: ${raw}`
      );
    }
    return normalized;
  });
}

export const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export function assertValidId(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !ID_PATTERN.test(raw)) {
    throw new ApiError(
      400,
      `"${label}" inválido. Usa el identificador exacto mostrado en el listado.`
    );
  }
  return raw;
}

import { SAFE_DELETE_PATTERNS, PROTECTED_PATHS } from "./config.js";
import path from "node:path";

export type Risk = "safe" | "review" | "protected";

export interface Classification {
  risk: Risk;
  reason: string;
}

export function classifyPath(relativePath: string): Classification {
  const normalized = relativePath.replace(/\\/g, "/");
  const name = path.basename(normalized);

  for (const protectedPath of PROTECTED_PATHS) {
    if (
      normalized === protectedPath ||
      normalized.startsWith(`${protectedPath}/`) ||
      name === protectedPath
    ) {
      return {
        risk: "protected",
        reason: `Coincide con una ruta protegida: ${protectedPath}`
      };
    }
  }

  for (const pattern of SAFE_DELETE_PATTERNS) {
    if (pattern.includes("*")) {
      const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`, "i");

      if (regex.test(name)) {
        return {
          risk: "safe",
          reason: `Coincide con el patrón regenerable: ${pattern}`
        };
      }
    }

    if (name === pattern) {
      return {
        risk: "safe",
        reason: `Carpeta o archivo regenerable conocido: ${pattern}`
      };
    }
  }

  return {
    risk: "review",
    reason: "No coincide con una regla segura conocida"
  };
}

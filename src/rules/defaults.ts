import type { CleanerRuleSet } from "../types/index.js";

/**
 * Reglas internas por defecto. Se usan cuando no existe `config/rules.json`.
 * La lista `protected` actúa además como invariante innegociable: el Safety
 * Guard la aplica siempre, aunque el usuario debilite su configuración.
 * Mantener sincronizada con `config/rules.json` (hay un test que lo verifica).
 */
export const DEFAULT_RULES: CleanerRuleSet = {
  version: 1,
  defaults: {
    mode: "dry-run",
    useTrash: true,
    maxDepth: 6,
    largeThresholdMB: 100
  },
  safe: [
    "node_modules",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".output",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".parcel-cache",
    ".vite",
    ".eslintcache",
    ".stylelintcache",
    "coverage",
    "target",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    ".gradle",
    ".dart_tool",
    ".terraform",
    "*.tsbuildinfo",
    "*.log",
    "*.tmp",
    "Thumbs.db",
    ".DS_Store"
  ],
  review: [
    "*.zip",
    "*.tar",
    "*.gz",
    "*.tgz",
    "*.7z",
    "*.rar",
    "*.iso",
    "*.img",
    "*.bin",
    "*.exe",
    "*.dll",
    "*.so",
    "*.dylib",
    "*.msi",
    "*.old",
    "*.orig",
    "*.swp",
    "*.iml",
    ".vs",
    "tmp",
    "temp",
    "logs",
    ".idea",
    ".vscode"
  ],
  protected: [
    ".git",
    ".github",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.crt",
    "*.cer",
    "*.keystore",
    "*.jks",
    "*.kdbx",
    ".ssh",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "id_rsa",
    "id_ed25519",
    "src",
    "app",
    "lib",
    "docs",
    "tests",
    "test",
    "config",
    "backups",
    "backup",
    "*.sqlite",
    "*.sqlite3",
    "*.db3",
    "*.mdb",
    "*.accdb",
    "*.dump",
    "*.bak",
    "*.backup",
    "secrets",
    "credentials",
    "claves",
    "keys",
    "certs",
    "reports",
    "clean-audit.jsonl",
    ".repo-cleaner-trash"
  ],
  // Reglas condicionadas al tipo de proyecto detectado. `bin`/`obj` solo
  // son safe en proyectos .NET (C#, F#, VB.NET, MAUI...); en cualquier otro
  // contexto quedan como review (ambigüedad). `.vs` es siempre review global.
  projectRules: {
    nodejs: {
      safe: [
        ".next",
        ".nuxt",
        ".output",
        ".svelte-kit",
        ".turbo",
        ".parcel-cache",
        ".vite",
        ".eslintcache",
        ".stylelintcache"
      ],
      safeNegations: []
    },
    typescript: { safe: ["*.tsbuildinfo"], safeNegations: [] },
    python: {
      safe: [
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".venv",
        "venv",
        ".tox",
        ".nox",
        "*.egg-info"
      ],
      safeNegations: []
    },
    rust: { safe: ["target"], safeNegations: [] },
    go: { safe: ["bin"], safeNegations: [] },
    gradle: { safe: ["build", ".gradle"], safeNegations: [] },
    maven: { safe: ["target"], safeNegations: [] },
    dotnet: { safe: ["bin", "obj"], safeNegations: [] },
    php: { safe: ["vendor"], safeNegations: [] },
    ruby: { safe: [".bundle"], safeNegations: [] }
  },
  // Exclusiones opcionales con prefijo "!" (rutas relativas del proyecto).
  // Ejemplo: "!dist/manifest.json" fuerza review de esa ruta y degrada el
  // directorio safe que la contiene. Nunca debilitan rutas protegidas.
  safeNegations: []
};

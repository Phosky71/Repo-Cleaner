export const SAFE_DELETE_PATTERNS = [
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
] as const;

export const PROTECTED_PATHS = [
  ".git",
  ".github",
  ".env",
  ".env.local",
  ".env.production",
  "src",
  "app",
  "lib",
  "docs",
  "tests",
  "test",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx"
] as const;

export const LARGE_THRESHOLD_MB = Number(
  process.env.REPO_CLEANER_LARGE_THRESHOLD_MB ?? 100
);

# Repo Cleaner

**Módulo de gestión y limpieza de proyectos de Meridian.** CLI y UI local
segura para detectar, clasificar, limpiar, restaurar y auditar artefactos de
build en repositorios de desarrollo, sin perder nunca trabajo valioso.

- **Versión:** 0.4.0 · **Licencia:** UNLICENSED (uso interno de Operia, no
  publicado en npm).
- **Estado:** Fases 1–5 completadas (núcleo seguro, limpieza con
  human-in-the-loop, papelera y restauración, UI web local, reglas por tipo
  de proyecto, empaquetado y documentación).

## Propósito

Mantener limpios los proyectos de desarrollo: recuperar espacio eliminando
únicamente artefactos regenerables (`node_modules`, `dist`, `target`,
`__pycache__`, `.venv`…), con clasificación por riesgo, confirmación humana
obligatoria, papelera local reversible y auditoría completa.

## Características principales

- Escaneo de una ruta raíz (p. ej. `C:\Trabajo`) con detección de proyectos
  en subcarpetas: Node.js, TypeScript, Python, Rust, Go, Java/Gradle, Maven,
  .NET (C#/F#/VB.NET/MAUI), PHP, Ruby.
- Metadatos por proyecto: lenguajes, gestores de paquetes, frameworks,
  comandos de regeneración recomendados (nunca se ejecutan), estado Git
  (solo lectura).
- Clasificación de artefactos: **safe / review / protected**.
- Limpieza con plan previo, selección individual o por categorías y
  confirmación explícita; papelera local por defecto; borrado permanente
  solo con elección explícita.
- Restauración desde papelera con gestión de conflictos (cancelar / sufijo
  único / sobrescribir con autorización adicional).
- Purga de sesiones de papelera completadas (nunca con pendientes).
- Reglas configurables (`config/rules.json`), reglas por tipo de proyecto y
  negaciones (`!ruta`).
- Auditoría JSONL de cada acción e informes JSON + Markdown.
- Interfaz web local minimalista (Hono + HTML/CSS/JS vanilla) en
  `127.0.0.1`, con informes históricos.
- 216 tests (Vitest), TypeScript estricto, ESLint 10, Prettier.

## Requisitos

- Node.js ≥ 20 (probado con Node 24) y npm.
- Windows, macOS o Linux (desarrollado y verificado en Windows).
- Git opcional: solo se usa en modo lectura (`git status --short`) para la
  verificación posterior a la limpieza.

## Instalación local

```bash
cd C:\Trabajo\Operia\repo-cleaner
npm install
npm run build
npm link          # instala el comando global repo-cleaner
```

Verificación del empaquetado (build, entrypoint, UI, reglas, comando global,
servidor local y tests):

```bash
npm run verify:package
```

Para retirar el comando global: `npm unlink -g repo-cleaner`.

## Comandos disponibles

```bash
repo-cleaner scan <ruta-raiz>          # detecta proyectos y artefactos (solo lectura)
repo-cleaner inspect <ruta-proyecto>   # análisis profundo + informe (solo lectura)
repo-cleaner clean <ruta-proyecto>     # plan + confirmación + papelera
repo-cleaner ui <ruta-raiz>            # interfaz web en http://127.0.0.1:4321
repo-cleaner restore <ruta-proyecto>   # restaura desde la papelera local
repo-cleaner trash <ruta-proyecto>     # gestiona/purga sesiones de papelera
repo-cleaner rules                     # muestra las reglas cargadas
```

Opciones comunes: `--config <ruta>` (reglas), `--reports-dir <dir>`,
`--audit-path <fichero>` (clean/restore/trash), `--dry-run`, `--yes`.
`scan`/`inspect`: `--verbose`. `clean`: `--permanent`, `--include-review`,
`--only <rutas...>`, `--exclude <rutas...>`, `--trash-dir <dir>`.
`restore`: `--session <timestamp>`, `--only <rutas...>`, `--all`,
`--on-conflict cancel|suffix|overwrite`. `trash`: `--session <timestamp>`,
`--remove`, `--remove-completed`. `ui`: `--port <n>`.

## Ejemplos reales

```bash
# Escanear todos los proyectos de C:\Trabajo
repo-cleaner scan C:\Trabajo --verbose

# Inspeccionar un proyecto concreto
repo-cleaner inspect C:\Trabajo\Operia\repo-cleaner

# Ver el plan de limpieza sin tocar nada
repo-cleaner clean C:\Trabajo\MiProyecto --dry-run

# Limpieza interactiva (papelera por defecto)
repo-cleaner clean C:\Trabajo\MiProyecto

# Selección concreta y automatización consciente
repo-cleaner clean C:\Trabajo\MiProyecto --only dist node_modules --yes

# Restaurar todo lo movido a la papelera
repo-cleaner restore C:\Trabajo\MiProyecto --all

# Purgar solo sesiones completadas
repo-cleaner trash C:\Trabajo\MiProyecto --remove-completed

# Interfaz web
repo-cleaner ui C:\Trabajo --port 5000
```

Sin `npm link`, todo funciona igual con `npm run dev -- <comando> ...`
(p. ej. `npm run dev -- scan C:\Trabajo`).

## Niveles de riesgo

| Nivel                | Significado                                           | Comportamiento                                                                  |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| **safe** (verde)     | Regenerable mediante build, test o gestor de paquetes | Incluido en el plan por defecto; se mueve a la papelera tras confirmación       |
| **review** (ámbar)   | Grande, ambiguo, binario o potencialmente valioso     | Solo con selección humana explícita (`--only`, `--include-review` o checkboxes) |
| **protected** (rojo) | Nunca eliminable                                      | Bloqueado en todas las capas; ni siquiera con reglas debilitadas                |

Reglas clave: lo desconocido nunca es safe; un safe no ignorado por
`.gitignore` se degrada a review; un conflicto safe+review se resuelve como
review; `.vs` es siempre review.

## Papelera local

Por defecto, limpiar **mueve** los elementos a
`<proyecto>/.repo-cleaner-trash/<timestamp>/`, con `manifest.json` (ruta
original absoluta y relativa, fecha, tamaño, riesgo, acción, motivo y hash
SHA-256 del plan) y los elementos en `items/`. Es reversible: `restore`
devuelve cada elemento a su ruta original. Las sesiones se conservan como
evidencia hasta que el usuario las purga explícitamente.

## Auditoría

Cada acción (limpieza, restauración, purga) se registra en
`logs/clean-audit.jsonl` (una línea JSON por acción: timestamp, target,
ruta relativa, riesgo, acción, tamaño, `approvedBy: "human"`, planId,
sessionId, resultado). Solo metadatos: nunca contenido de ficheros ni
secretos. El registro se conserva aunque se purgue la sesión.

## Informes

Cada operación genera informe **JSON y Markdown** en `reports/`:
`root-scan-*` (escaneo de raíz), `scan-*` (inspección), `clean-*`,
`restore-*`, `trash-*`. La UI muestra el histórico y permite abrirlos y
descargarlos (solo lectura).

## Reglas personalizadas

`config/rules.json` define `defaults` (modo, papelera, `maxDepth`,
`largeThresholdMB`), las listas `safe`, `review`, `protected`,
`projectRules` y `safeNegations`. Sin archivo, se usan las reglas internas.
La validación rechaza patrones peligrosos y **nunca permite debilitar las
protecciones internas**.

### Negaciones

```json
{
  "safeNegations": [
    "!dist/manifest.json",
    "!node_modules/.cache/important-data"
  ]
}
```

Una negación fuerza `review` de la ruta excluida y degrada el directorio
safe que la contiene. Jamás debilita una ruta protegida.

### Reglas por tipo de proyecto

`projectRules` aplica reglas solo cuando el tipo se detecta con confianza
(marcadores reales). Incluidas: nodejs (cachés de framework), typescript
(`*.tsbuildinfo`), python (`__pycache__`, `.venv`, `.tox`, `*.egg-info`…),
rust (`target`), go (`bin`), gradle/maven, dotnet (`bin`/`obj`), php
(`vendor`), ruby (`.bundle`). Se acepta el alias `node` → `nodejs`. Con
varios tipos, unión de reglas safe; cualquier conflicto → review.

## Seguridad: qué nunca se elimina

`.git`, `.github`, `.env` y variantes, claves y certificados (`*.pem`,
`*.key`, `*.p12`, `*.pfx`, `*.crt`, `*.keystore`, `.ssh`…), código fuente
(`src`, `app`, `lib`), tests, documentación, configuración, bases de datos
(`*.sqlite`, `*.dump`…), backups, `reports/`, `logs/clean-audit.jsonl` y la
propia papelera. Nunca rutas fuera del objetivo, nunca `..`, nunca symlinks.
Sin `rm -rf` genérico ni `git clean`. Modelo completo:
[`docs/SAFETY.md`](docs/SAFETY.md).

## Desarrollo

```bash
npm install
npm run dev -- scan .        # CLI en desarrollo (tsx)
npm run typecheck            # TypeScript estricto (src + tests)
npm test                     # Vitest (216 tests)
npm run lint                 # ESLint 10
npm run format               # Prettier
npm run build                # tsc + copia de assets UI a dist/
npm run verify:package       # verificación completa de empaquetado
```

Arquitectura: `src/cli` (Commander), `src/core` (scanner, project-meta,
rule-engine, safety, cleaner, trash, trash-admin, restore, audit, git,
inspect, report, format), `src/rules` (defaults + loader), `src/types`,
`src/ui` (servidor Hono + validación + frontend vanilla).

## Documentación

- [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md) — guía práctica de uso diario.
- [`docs/PLAN.md`](docs/PLAN.md) — plan por fases y decisiones técnicas.
- [`docs/SAFETY.md`](docs/SAFETY.md) — referencia de seguridad.

## Licencia

UNLICENSED — uso interno de Operia/Meridian. No publicado en npm.

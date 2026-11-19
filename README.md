# Repo Cleaner

Repo Cleaner es una herramienta de línea de comandos y aplicación web local para escanear, inspeccionar y limpiar proyectos de desarrollo de forma segura.

Forma parte de **Meridian**, un gestor de proyectos pensado para desarrolladores. Su objetivo es mantener tus repositorios limpios sin eliminar código fuente, configuración, secretos, documentación ni trabajo importante.

Repo Cleaner detecta builds, cachés, dependencias reinstalables y archivos temporales, muestra un plan claro y solicita confirmación humana antes de eliminar nada.

[![CI](https://github.com/Phosky71/Repo-Cleaner/actions/workflows/ci.yml/badge.svg)](https://github.com/Phosky71/Repo-Cleaner/actions/workflows/ci.yml)

## Características

- Escaneo de una carpeta raíz y detección de proyectos en subcarpetas.
- Inspección profunda de un proyecto.
- Detección de artefactos de build, cachés, dependencias y temporales.
- Clasificación `safe`, `review` y `protected`.
- Human-in-the-loop obligatorio antes de eliminar.
- Papelera local reversible.
- Restauración desde papelera (con gestión de conflictos).
- Purga controlada de sesiones completadas.
- Auditoría JSONL de cada acción.
- Informes JSON y Markdown.
- Interfaz web local minimalista (solo `127.0.0.1`).
- Reglas configurables.
- Reglas por tipo de proyecto.
- Reglas negadas (exclusiones).
- Detección de lenguajes, gestores de paquetes y frameworks.
- Comandos de regeneración recomendados, sin ejecutarlos automáticamente.

## Problemas que resuelve

- Disco lleno de `node_modules`, `dist`, `target`, `.venv` y cachés en decenas de proyectos.
- Miedo a borrar algo valioso: clasificación conservadora, protecciones innegociables y papelera reversible.
- Falta de trazabilidad: informes y auditoría de cada movimiento, borrado, restauración o purga.
- Limpiezas a ciegas: nunca se elimina nada sin plan previo y confirmación explícita.

## Requisitos

- Node.js ≥ 20 (probado con Node 24) y npm.
- Windows, macOS o Linux.
- Git opcional: solo se usa en modo lectura (`git status --short`) para verificar el estado tras limpiar.

## Instalación

```bash
git clone https://github.com/Phosky71/Repo-Cleaner.git
cd Repo-Cleaner
npm install
npm run build
npm link
```

`npm link` instala el comando global `repo-cleaner`. Verifica la instalación con `npm run verify:package` (8 comprobaciones). Para retirarlo: `npm unlink -g repo-cleaner`.

## Uso rápido

```bash
repo-cleaner scan C:\Trabajo
repo-cleaner inspect C:\Trabajo\MiProyecto
repo-cleaner clean C:\Trabajo\MiProyecto
repo-cleaner ui C:\Trabajo
repo-cleaner restore C:\Trabajo\MiProyecto
repo-cleaner trash C:\Trabajo\MiProyecto
repo-cleaner rules
```

Sin `npm link`, todo funciona con `npm run dev -- <comando> ...`.

| Comando              | Función                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `scan <ruta-raíz>`   | Detecta proyectos y artefactos (solo lectura)                                                 |
| `inspect <proyecto>` | Análisis profundo: tipos, lenguajes, gestores, frameworks, Git, artefactos con motivo y regla |
| `clean <proyecto>`   | Plan + selección + confirmación + papelera                                                    |
| `ui <ruta-raíz>`     | Interfaz web local (`--port` configurable)                                                    |
| `restore <proyecto>` | Restaura desde la papelera (`--session`, `--only`, `--all`, `--on-conflict`)                  |
| `trash <proyecto>`   | Lista/inspecciona sesiones y purga las completadas (`--remove`, `--remove-completed`)         |
| `rules`              | Muestra las reglas cargadas                                                                   |

Opciones destacadas de `clean`: `--dry-run` (solo plan), `--yes` (automatización consciente), `--permanent` (borrado definitivo con confirmación reforzada), `--include-review`, `--only <rutas...>`, `--exclude <rutas...>`, `--trash-dir`, `--config`, `--audit-path`, `--reports-dir`.

Ejemplo de flujo seguro:

```bash
repo-cleaner clean C:\Trabajo\MiProyecto --dry-run   # 1. revisar el plan
repo-cleaner clean C:\Trabajo\MiProyecto             # 2. confirmar y mover a papelera
repo-cleaner restore C:\Trabajo\MiProyecto --all     # 3. deshacer si hace falta
```

## Interfaz web

```bash
repo-cleaner ui C:\Trabajo
```

Abre:

```text
http://127.0.0.1:4321
```

Flujo:

```text
Escanear → Inspeccionar → Seleccionar artefactos → Generar plan → Confirmar → Papelera → Restaurar
```

La UI incluye filtros por riesgo, selección individual y por categorías, metadatos del proyecto, advertencias, confirmaciones reforzadas (escribir `PERMANENTE` o `OVERWRITE`), vista de papelera con restauración y purga, e histórico de informes con apertura y descarga JSON/Markdown. Diseño oscuro, minimalista, HTML/CSS/JS vanilla, CSP estricta y `textContent` (sin frameworks).

## Seguridad

- El modo por defecto es seguro: `scan` e `inspect` son de solo lectura; nada se elimina sin confirmación humana explícita.
- La papelera local es el comportamiento por defecto; el borrado permanente (`--permanent`) requiere confirmación reforzada.
- `.git`, `.env`, claves, certificados, código fuente, tests, documentación, bases de datos y backups **nunca** se eliminan.
- Las rutas fuera del target y los `..` están bloqueados en todas las capas.
- Los symlinks y junctions no se siguen ni se eliminan.
- Cada acción queda registrada en auditoría.
- Los planes tienen TTL (15 min) y consumo único garantizado bajo concurrencia.
- El servidor web escucha solo en `127.0.0.1`, valida Host/Origin y no ejecuta comandos arbitrarios.

Modelo completo: [`docs/SAFETY.md`](docs/SAFETY.md).

## Papelera y restauración

Al limpiar, los elementos se mueven a `<proyecto>/.repo-cleaner-trash/<timestamp>/` con un `manifest.json` (ruta original, relativa, almacenada, fecha, tamaño, riesgo, acción, motivo y hash SHA-256 del plan). `restore` los devuelve a su ruta original; si el destino ya existe, elige entre cancelar, sufijo único (`nombre.restored-<timestamp>`) o sobrescribir con autorización adicional. Las sesiones se conservan como evidencia hasta que las purgas explícitamente (`trash --remove-completed` solo elimina sesiones sin elementos pendientes de restaurar).

## Auditoría

Cada acción se registra en `logs/clean-audit.jsonl` (una línea JSON por acción: timestamp, target, ruta relativa, riesgo, acción, tamaño, `approvedBy: "human"`, planId, sessionId y resultado). Solo metadatos: nunca contenido de ficheros ni secretos. El registro se conserva aunque se purgue la sesión.

## Informes

Cada operación genera informe JSON y Markdown en `reports/`: `root-scan-*`, `scan-*` (inspect), `clean-*`, `restore-*`, `trash-*`. La UI muestra el histórico y permite abrirlos y descargarlos (solo lectura).

## Reglas

`config/rules.json` define el comportamiento:

- `safe`: artefactos regenerables (build, test, gestor de paquetes).
- `review`: grandes, ambiguos, binarios o potencialmente valiosos; solo con selección humana explícita.
- `protected`: nunca eliminables.
- `safeNegations`: exclusiones con prefijo `!` que fuerzan `review`.
- `projectRules`: reglas que solo aplican cuando el tipo de proyecto se detecta con confianza.

Ejemplo real:

```json
{
  "version": 1,
  "defaults": {
    "mode": "dry-run",
    "useTrash": true,
    "maxDepth": 6,
    "largeThresholdMB": 100
  },
  "safe": ["node_modules", "dist", "*.log"],
  "review": ["*.zip", "*.bin", ".vs"],
  "protected": [".git", ".env", "src", "docs"],
  "projectRules": {
    "dotnet": { "safe": ["bin", "obj"], "safeNegations": [] }
  },
  "safeNegations": ["!dist/manifest.json"]
}
```

Una negación **nunca puede debilitar una ruta protegida**: la prioridad es protected > negación > review > safe, y las protecciones internas se fusionan siempre con las del usuario. `bin`/`obj` solo son safe en proyectos .NET detectados; en otros contextos son review. Lo desconocido nunca es safe; un safe no ignorado por `.gitignore` se degrada a review.

## Arquitectura

```text
CLI / Web UI
     │
     ▼
Cleaner Service
     │
     ├── Scanner
     ├── Project Detector
     ├── Rule Engine
     ├── Safety Guard
     ├── Trash / Restore
     ├── Audit
     └── Report Generator
```

En código: `src/cli` (Commander), `src/core` (scanner, project-meta, rule-engine, safety, cleaner, trash, trash-admin, restore, audit, git, inspect, report, format), `src/rules` (defaults + loader validado), `src/types`, `src/ui` (servidor Hono + validación + frontend vanilla). TypeScript estricto, ESM, sin dependencias pesadas.

## CI

El proyecto incluye integración continua para:

- GitHub Actions: `.github/workflows/ci.yml`
- Gitea Actions: `.gitea/workflows/ci.yml`

Ambos workflows ejecutan:

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run verify:package
```

Se disparan en push a `main` y en pull requests hacia `main`, usan Node.js 20, permisos mínimos (`contents: read`), sin secretos, sin publicación en npm y sin push automático. Suben `reports/`, `logs/` y `coverage/` como artefactos si existen.

## Desarrollo

```bash
npm install
npm run dev -- scan .
npm run typecheck
npm test
npm run lint
npm run format
npm run build
npm run verify:package
```

219 tests (Vitest) cubren scanner, reglas, negaciones, safety guard, limpieza, papelera, restauración, purga, API, UI, concurrencia y empaquetado. ESLint 10 + Prettier.

## Desarrollo con OpenCode

Este repositorio está preparado para que [OpenCode](https://opencode.ai) lo entienda, lo use y continúe su desarrollo:

1. `AGENTS.md` contiene las reglas del agente (seguridad pre-commit, ahorro de tokens, estándar Gradle si aplicara).
2. `opencode.json` configura el agente `repo-cleaner` y sus permisos.
3. `docs/PLAN.md` contiene el plan por fases, decisiones técnicas y el estado del proyecto.
4. `docs/SAFETY.md` contiene la política de seguridad completa.
5. `docs/USER-GUIDE.md` contiene la guía de usuario.
6. `prompts/continuity.md` contiene el prompt de continuidad para retomar el desarrollo por fases.
7. Cualquier cambio debe pasar:

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run verify:package
```

8. No se deben eliminar rutas protegidas ni debilitar la seguridad (las invariantes internas no son negociables).
9. Los cambios deben ser incrementales y verificados; los commits requieren confirmación humana y el gate `operia-code-gate`.

## Licencia

Este proyecto está distribuido bajo la [MIT License](./LICENSE).

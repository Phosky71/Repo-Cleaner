# Guía de usuario — Repo Cleaner

Guía práctica para el uso diario de Repo Cleaner (v0.4.0), el módulo de
limpieza de proyectos de Meridian. Todos los comandos son copiables y están
verificados contra el comportamiento real de la aplicación.

## Índice

1. [Qué es Repo Cleaner](#1-qué-es-repo-cleaner)
2. [Qué problemas resuelve](#2-qué-problemas-resuelve)
3. [Requisitos del sistema](#3-requisitos-del-sistema)
4. [Instalación local con npm link](#4-instalación-local-con-npm-link)
5. [Cómo escanear una carpeta raíz](#5-cómo-escanear-una-carpeta-raíz)
6. [Cómo inspeccionar un proyecto](#6-cómo-inspeccionar-un-proyecto)
7. [Cómo limpiar de forma segura](#7-cómo-limpiar-de-forma-segura)
8. [Cómo usar la papelera](#8-cómo-usar-la-papelera)
9. [Cómo restaurar archivos](#9-cómo-restaurar-archivos)
10. [Cómo purgar sesiones completadas](#10-cómo-purgar-sesiones-completadas)
11. [Cómo personalizar reglas](#11-cómo-personalizar-reglas)
12. [Cómo usar la interfaz web](#12-cómo-usar-la-interfaz-web)
13. [Qué archivos nunca se eliminan](#13-qué-archivos-nunca-se-eliminan)
14. [Qué hacer si algo sale mal](#14-qué-hacer-si-algo-sale-mal)
15. [Cómo consultar informes históricos](#15-cómo-consultar-informes-históricos)
16. [Cómo desinstalar el comando global](#16-cómo-desinstalar-el-comando-global)

---

## 1. Qué es Repo Cleaner

Una herramienta local (CLI + interfaz web) que detecta artefactos
generados, temporales y reinstalables en tus proyectos de desarrollo, los
clasifica por riesgo y los limpia **solo con tu confirmación explícita**,
moviéndolos por defecto a una papelera local reversible y registrando cada
acción en un log de auditoría.

No ejecuta builds, tests, installs ni comandos del sistema. Los comandos de
regeneración que muestra son **solo recomendaciones**.

## 2. Qué problemas resuelve

- Disco lleno de `node_modules`, `dist`, `target`, `.venv`, cachés… en
  decenas de proyectos.
- Miedo a borrar algo valioso: clasificación conservadora, protecciones
  innegociables y papelera reversible.
- Falta de trazabilidad: informes JSON/Markdown y auditoría JSONL de cada
  acción.
- Limpieza a ciegas: nunca se elimina nada sin plan previo y confirmación.

## 3. Requisitos del sistema

- Node.js ≥ 20 (probado con Node 24) y npm.
- Windows, macOS o Linux.
- Git opcional (solo se usa en modo lectura para verificar el estado del
  repositorio tras limpiar).

## 4. Instalación local con npm link

```bash
cd C:\Trabajo\Operia\repo-cleaner
npm install
npm run build
npm link
```

Comprueba la instalación:

```bash
repo-cleaner --version        # 0.4.0
npm run verify:package        # 8 comprobaciones de empaquetado
```

Sin `npm link`, todos los comandos funcionan con
`npm run dev -- <comando> ...` desde la carpeta del repo.

## 5. Cómo escanear una carpeta raíz

```bash
repo-cleaner scan C:\Trabajo
repo-cleaner scan C:\Trabajo --verbose
```

Salida esperada (resumen):

```text
  PROYECTO                            TIPO                      TAMAÑO  MODIFICADO  ARTEFACTOS
  Operia/repo-cleaner                 TypeScript · Node.js     113.3 MB   2026-11-18  2 safe · 1 review
  Proyectos/api                       Python                    42.1 MB   2026-11-10  2 safe

Proyectos detectados: 2 (2 con artefactos)
Tamaño total aproximado: 155.4 MB
Limpiable (safe): 106.5 MB · Revisar (review): 86 B · Artefactos: 5
Informe JSON:     ...\reports\root-scan-...json
Informe Markdown: ...\reports\root-scan-...md
```

- Detecta proyectos por marcadores reales (`package.json`, `pyproject.toml`,
  `Cargo.toml`, `go.mod`, `*.csproj`, `build.gradle`, `pom.xml`…).
- Si la ruta ya es un proyecto, lo analiza como único proyecto.
- **Solo lectura**: no modifica nada.
- Opciones: `--verbose` (detalle de artefactos), `--config <ruta>`,
  `--reports-dir <dir>`.

## 6. Cómo inspeccionar un proyecto

```bash
repo-cleaner inspect C:\Trabajo\Operia\repo-cleaner
repo-cleaner inspect C:\Trabajo\MiProyecto --verbose
```

Muestra: tipos detectados, lenguajes, gestores de paquetes, frameworks,
estado Git (repositorio / cambios pendientes), comandos de regeneración
recomendados (p. ej. `npm install`, `npm run build`, `cargo build`,
`dotnet build` — **nunca se ejecutan**), artefactos con tamaño, motivo y
regla, y advertencias (contenido importante en zonas regenerables, safe no
ignorado por Git, falta de `.gitignore`).

Ejemplos por ecosistema:

```bash
repo-cleaner inspect C:\Trabajo\web-next        # Node.js/TypeScript (Next.js)
repo-cleaner inspect C:\Trabajo\api-python      # Python (pip/uv/poetry)
repo-cleaner inspect C:\Trabajo\cli-rust        # Rust (cargo)
repo-cleaner inspect C:\Trabajo\servicio-go     # Go
repo-cleaner inspect C:\Trabajo\app-maui        # .NET MAUI (bin/obj safe)
```

`--verbose` añade los elementos protegidos al listado. Genera informe
JSON/MD en `reports/`.

## 7. Cómo limpiar de forma segura

```bash
# 1. Ver el plan sin tocar nada (recomendado siempre primero)
repo-cleaner clean C:\Trabajo\MiProyecto --dry-run

# 2. Limpieza interactiva: selección + confirmación + papelera
repo-cleaner clean C:\Trabajo\MiProyecto

# 3. Automatización consciente (muestra el plan y ejecuta sin prompts)
repo-cleaner clean C:\Trabajo\MiProyecto --yes
```

Flujo real: análisis → plan numerado (solo **safe** por defecto) →
selección (Enter = todos, números, `all`, `none`) → confirmación escribiendo
`yes` o `sí` → papelera → auditoría → verificación Git → informe final.

Opciones de `clean`:

| Opción                                      | Efecto                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `--dry-run`                                 | Solo muestra el plan; no elimina ni mueve nada                                                      |
| `--yes`                                     | Confirma automáticamente (automatización consciente)                                                |
| `--permanent`                               | Borrado definitivo en vez de papelera. **Irreversible**; en interactivo exige escribir `PERMANENTE` |
| `--include-review`                          | Añade los elementos review al plan (decisión explícita)                                             |
| `--only <rutas...>`                         | Selecciona solo esas rutas relativas (safe o review)                                                |
| `--exclude <rutas...>`                      | Excluye rutas del plan                                                                              |
| `--trash-dir <dir>`                         | Papelera en un directorio alternativo validado                                                      |
| `--config`, `--audit-path`, `--reports-dir` | Rutas de reglas, auditoría e informes                                                               |

> Nota: la papelera es **siempre** el comportamiento por defecto; no existe
> flag `--use-trash` (no hace falta). El borrado permanente requiere
> `--permanent` explícito.

⚠ Sin terminal interactivo y sin `--yes`, `clean` se niega a ejecutar.
⚠ Nunca se eliminan elementos protected, ni rutas fuera del proyecto.

## 8. Cómo usar la papelera

Al limpiar, los elementos se mueven a:

```text
<proyecto>/.repo-cleaner-trash/
└── 20261118-171522/
    ├── manifest.json     # metadatos completos + hash SHA-256 del plan
    └── items/
        ├── 0001-debug.log
        ├── 0002-dist/
        └── 0003-node_modules/
```

El manifest conserva por elemento: ruta original absoluta, ruta relativa,
ruta almacenada, fecha, tamaño, riesgo, acción, motivo y hash del plan; y
tras restaurar: `restored`, `restoredAt`, `restoredPath`.

Las sesiones **nunca se borran automáticamente**: son evidencia hasta que
tú las purgas (sección 10).

## 9. Cómo restaurar archivos

```bash
# Listar sesiones y restaurar interactivamente
repo-cleaner restore C:\Trabajo\MiProyecto

# Sesión concreta, todo lo pendiente
repo-cleaner restore C:\Trabajo\MiProyecto --session 20261118-171522 --all

# Solo un elemento
repo-cleaner restore C:\Trabajo\MiProyecto --session 20261118-171522 --only dist

# Ver el plan sin restaurar
repo-cleaner restore C:\Trabajo\MiProyecto --all --dry-run
```

Opciones: `--session <timestamp>`, `--only <rutas...>`, `--all`,
`--on-conflict cancel|suffix|overwrite`, `--dry-run`, `--yes`, `--config`,
`--audit-path`, `--reports-dir`.

Conflictos (la ruta original ya existe):

- `cancel` (defecto): no toca el destino; resultado `conflict` (u omitido si
  el contenido es idéntico).
- `suffix`: restaura como `nombre.restored-<timestamp>` sin tocar el
  existente.
- `overwrite`: reemplaza el existente **solo con autorización adicional**
  (escribir `overwrite` en interactivo, o `--on-conflict overwrite --yes`).

⚠ Nunca se restaura sobre rutas protegidas ni fuera del proyecto; nunca se
siguen symlinks. Cada restauración se audita y el manifest se actualiza.

## 10. Cómo purgar sesiones completadas

```bash
# Listar sesiones (estado, pendientes, restaurados, tamaño, hash)
repo-cleaner trash C:\Trabajo\MiProyecto

# Inspeccionar una sesión
repo-cleaner trash C:\Trabajo\MiProyecto --session 20261118-171522

# Eliminar una sesión concreta (solo si es elegible)
repo-cleaner trash C:\Trabajo\MiProyecto --session 20261118-171522 --remove

# Eliminar todas las sesiones sin pendientes de restaurar
repo-cleaner trash C:\Trabajo\MiProyecto --remove-completed

# Ver qué se eliminaría sin tocar nada
repo-cleaner trash C:\Trabajo\MiProyecto --remove-completed --dry-run
```

Una sesión solo es elegible si **no queda ningún elemento pendiente de
restaurar** (todo restaurado, omitido por idéntico, fallido irreversible o
almacén ausente). Confirmación explícita obligatoria (`yes`/`sí` o `--yes`).
La auditoría de la purga (`action: "purge"`) se conserva aunque la sesión
desaparezca.

## 11. Cómo personalizar reglas

Edita `config/rules.json` (o usa `--config mis-reglas.json`):

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

- `safe`: regenerable; `review`: revisión humana; `protected`: nunca.
- `projectRules`: solo se aplican con el tipo detectado (alias `node` →
  `nodejs`). Varios tipos → unión de safe; conflictos → review.
- `safeNegations`: rutas con `!` que fuerzan review y degradan el
  directorio safe que las contiene. Nunca debilitan protected.
- La validación rechaza `..`, rutas absolutas y patrones que intenten
  convertir en safe algo protegido. Las protecciones internas siempre se
  fusionan: no se pueden debilitar.
- Consulta las reglas cargadas: `repo-cleaner rules`.

## 12. Cómo usar la interfaz web

```bash
repo-cleaner ui C:\Trabajo              # http://127.0.0.1:4321
repo-cleaner ui C:\Trabajo --port 5000  # puerto alternativo
```

El servidor escucha **solo en 127.0.0.1** (nunca expuesto a la red). Flujo:

1. **Inicio**: ruta raíz (precargada con la autorizada) → _Escanear_.
2. **Proyectos**: tarjetas con tipo, tamaño, fecha y artefactos →
   _Inspeccionar_ o _Copiar ruta_.
3. **Inspección**: metadatos (lenguajes, gestores, frameworks, Git),
   regeneración recomendada, advertencias, filtros safe/review/protected,
   checkboxes (protected bloqueados), _Seleccionar safe_, acción
   papelera/permanente → _Generar plan_.
4. **Plan**: elementos, total, hash, caducidad (15 min) → _Confirmar
   limpieza_. Con permanente: aviso rojo y escribir `PERMANENTE`.
5. **Resultado**: estadísticas, nota Git, descargas JSON/MD.
6. **Papelera** (botón en inspección): sesiones con estado, detalle,
   selección, resolución de conflictos, _Restaurar selección_ (escribir
   `OVERWRITE` si se sobrescribe) y _Purgar sesiones completadas_ con
   confirmación.
7. **Informes** (topbar): histórico con fecha, tipo, proyecto, resumen;
   _Ver_ / _Markdown_ / descargas JSON ↓ / MD ↓. Solo lectura.

Todo el contenido dinámico usa `textContent` y CSP estricta. Ningún botón
ejecuta comandos del sistema.

## 13. Qué archivos nunca se eliminan

- `.git`, `.github`.
- `.env` y variantes; claves y certificados: `*.pem`, `*.key`, `*.p12`,
  `*.pfx`, `*.crt`, `*.cer`, `*.keystore`, `*.jks`, `*.kdbx`, `.ssh`,
  `.npmrc`, `.pypirc`, `.netrc`, `id_rsa`, `id_ed25519`.
- Código fuente y estructura: `src`, `app`, `lib`, `config`.
- Tests y documentación: `tests`, `test`, `docs`.
- Bases de datos y backups: `*.sqlite`, `*.sqlite3`, `*.db3`, `*.mdb`,
  `*.accdb`, `*.dump`, `*.bak`, `*.backup`, `backups`, `backup`.
- Secretos: `secrets`, `credentials`, `claves`, `keys`, `certs`.
- Evidencia de la herramienta: `reports`, `clean-audit.jsonl`,
  `.repo-cleaner-trash`.
- Cualquier ruta fuera del proyecto, con `..`, o symlinks/junctions.
- Binarios y archivos desconocidos: nunca safe por defecto.

## 14. Qué hacer si algo sale mal

- **Limpiaste algo que no debías**: está en la papelera.
  `repo-cleaner restore <proyecto> --session <timestamp> --only <ruta>`.
- **Conflicto al restaurar** (el destino ya existe): usa
  `--on-conflict suffix` para conservar ambos, o `overwrite` solo si estás
  seguro.
- **Git avisa de ficheros versionados eliminados**: revisa el informe
  `clean-*.md` y restaura desde papelera; no hagas commit hasta revisarlo.
- **Plan expirado** (15 min): genera uno nuevo desde la inspección.
- **Error de ruta**: comprueba que esté dentro de la raíz autorizada al
  lanzar `ui`, que exista y sea un directorio.
- **Auditoría**: consulta `logs/clean-audit.jsonl` para ver exactamente qué
  se movió/eliminó/restauró, cuándo y con qué plan.
- **Sospecha de comportamiento incorrecto**: detén el uso, conserva
  `reports/`, `logs/` y `.repo-cleaner-trash/` como evidencia y revisa
  `docs/SAFETY.md`.

## 15. Cómo consultar informes históricos

- En disco: `reports/` contiene `root-scan-*`, `scan-*` (inspect),
  `clean-*`, `restore-*`, `trash-*` en JSON y Markdown.
- En la UI: botón **Informes** → histórico ordenado por fecha → _Ver_
  (JSON), _Markdown_, o descargas JSON ↓ / MD ↓.
- Los informes son de solo lectura: la UI no permite editarlos ni
  borrarlos.

## 16. Cómo desinstalar el comando global

```bash
npm unlink -g repo-cleaner
```

El repositorio, sus informes, auditoría y papelera no se modifican al
desenlazar. Para reinstalar: `npm link` de nuevo desde la carpeta del repo.

---

### Referencia rápida de niveles de riesgo

- **safe** (verde): regenerable; entra en el plan por defecto; papelera tras
  confirmación.
- **review** (ámbar): ambiguo/grande/binario; solo con selección explícita.
- **protected** (rojo): nunca eliminable en ninguna capa.

### Advertencias finales

- `--permanent` es **irreversible**: no hay papelera ni restauración.
- `--yes` omite prompts: úsalo solo tras revisar el plan con `--dry-run`.
- La purga de sesiones elimina el almacén de la papelera: hazlo solo cuando
  ya no necesites restaurar nada de esa sesión.

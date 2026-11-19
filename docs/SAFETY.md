# Referencia de seguridad — Repo Cleaner

Modelo de seguridad completo (v0.4.0). Las protecciones son de defensa en
profundidad: clasificación → configuración validada → Safety Guard →
papelera/restore → UI. Ninguna capa puede debilitar las invariantes.

## 1. Dry-run por defecto

`scan` e `inspect` son 100% de solo lectura. `clean`, `restore` y `trash`
no ejecutan nada sin confirmación explícita; `--dry-run` fuerza solo-plan.
Sin terminal interactivo y sin `--yes`, la ejecución se rechaza.

## 2. Human-in-the-loop obligatorio

Toda acción destructiva requiere: análisis → plan visible → selección →
confirmación explícita (`yes`/`sí`, o `--yes` consciente). En la UI, botón
de confirmación deshabilitado hasta plan válido; acciones irreversibles
exigen escribir una palabra clave (`PERMANENTE`, `OVERWRITE`).

## 3. Rutas protegidas

`.git`, `.github`, `src`, `app`, `lib`, `docs`, `tests`, `test`, `config`,
`backups`, `backup`, `secrets`, `credentials`, `claves`, `keys`, `certs`,
`reports`, `clean-audit.jsonl`, `.repo-cleaner-trash`. Un nombre protegido
protege todo su contenido. La lista interna se **fusiona** siempre con la
del usuario: nunca se debilita.

## 4. Secretos y certificados

`.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`, `*.cer`,
`*.keystore`, `*.jks`, `*.kdbx`, `.ssh`, `.npmrc`, `.pypirc`, `.netrc`,
`id_rsa`, `id_ed25519`. La auditoría y los informes solo contienen
metadatos: nunca contenido de ficheros ni valores de secretos.

## 5. Código fuente, tests, documentación y bases de datos

Protegidos por ruta (sección 3) y por patrón: `*.sqlite`, `*.sqlite3`,
`*.db3`, `*.mdb`, `*.accdb`, `*.dump`, `*.bak`, `*.backup`. Binarios
desconocidos → review, nunca safe. `Thumbs.db` es safe (caché de
miniaturas); no choca con los patrones de BD reales.

## 6. Validación de rutas y prevención de path traversal

- Rechazo de segmentos `..` sobre la ruta **cruda** (antes de normalizar)
  en motor de reglas, Safety Guard, papelera, restore y validación UI.
- `path.relative` contra el target: fuera del objetivo → bloqueado.
- En la API: toda ruta se valida contra la raíz autorizada (existencia,
  directorio, sin escapes); IDs con patrón cerrado `[A-Za-z0-9-]{1,64}`;
  los informes se sirven solo desde el directorio autorizado (nombres del
  readdir, nunca rutas derivadas de la entrada).
- Coherencia anti-manipulación en restore: `relativePath` debe coincidir
  con la ruta original relativa calculada; `storedPath` dentro de la sesión.

## 7. Symlinks y junctions

Nunca se siguen ni se eliminan ni se restauran: scanner, papelera, restore
(comprueba también los ancestros del destino) y listado de sesiones los
excluyen.

## 8. Papelera local

`<proyecto>/.repo-cleaner-trash/<timestamp>/` con `manifest.json` (ruta
original absoluta/relativa, almacenada, fecha, tamaño, riesgo, acción,
motivo, hash SHA-256 del plan; tras restaurar: `restored`, `restoredAt`,
`restoredPath`) y `items/`. Rename atómico; fallback copy+delete solo en
EXDEV. Nunca se crea dentro de un elemento a mover. Sesiones conservadas
como evidencia; nunca borrado automático.

## 9. Borrado permanente

Solo con `--permanent` explícito (CLI) o acción permanent elegida al crear
el plan (UI). Confirmación adicional escribiendo `PERMANENTE`. La acción de
ejecución debe coincidir con la del plan. `fs.rm` dirigido por elemento
tras el guard; nunca `rm -rf` genérico.

## 10. Auditoría

`logs/clean-audit.jsonl`: una línea JSON por acción con timestamp, target,
relativePath, risk, action (`trash|permanent|restore|purge`), sizeBytes,
`approvedBy: "human"`, planId, sessionId, result
(`trashed|deleted|restored|conflict|purged|failed|skipped`), overwritten?,
error?. Solo metadatos. El registro se conserva aunque se purgue la sesión.

## 11. Reglas negadas

`safeNegations` (globales y por tipo) con prefijo `!`: fuerzan review de la
ruta excluida y su descendencia; degradan a review el directorio safe que
las contiene (prefijo literal). Prioridad: protected > negación > review >
safe. Validación: sin `..`, sin absolutas. Nunca convierten protected en
eliminable.

## 12. Reglas por tipo de proyecto

`projectRules` solo se aplican con tipo detectado por marcadores reales.
`bin`/`obj` safe únicamente en .NET; en otros contextos, review. Varios
tipos → unión de safe; conflictos → review. Protecciones condicionadas
también se fusionan con las internas. Alias `node` → `nodejs`.

## 13. Límites del servidor web

- Escucha **exclusivamente en 127.0.0.1**; nunca 0.0.0.0.
- Host/Origin solo locales (anti DNS-rebinding y CSRF).
- CSP estricta: `default-src 'self'`, sin unsafe-inline/eval.
- Frontend vanilla con `textContent` (anti XSS); sin innerHTML.
- Sin endpoints de edición/borrado de informes; sin ejecución de comandos.
- Planes con TTL (15 min) y un solo uso; revalidación del target al ejecutar.
- Raíz autorizada fija por argumento `ui`; toda ruta fuera se rechaza.

## 14. Confirmaciones destructivas

- Papelera: nota de reversibilidad + nº elementos + tamaño + confirmación.
- Permanente: aviso rojo + irreversible + palabra `PERMANENTE`.
- Sobrescritura en restore: lista de rutas afectadas + aviso rojo +
  `OVERWRITE` + `overwriteConfirmed: true` en API.
- Purga: nº sesiones/elementos/tamaño + nota de auditoría conservada +
  confirmación; solo sesiones sin pendientes.

## 15. Restauración segura

Solo dentro del target; nunca sobre protegidos (doble barrera: reglas
vigentes + invariantes); conflictos cancel/suffix/overwrite con
autorización adicional; destino idéntico con cancel → omitido; almacén
ausente → skipped; manifest actualizado; auditoría por elemento.

## 16. Purga de sesiones

Elegibilidad: `restorableCount === 0` (todo restaurado, omitido por
idéntico, fallido irreversible o almacén ausente). Sesiones con pendientes
**nunca** se purgan. Confirmación explícita; auditoría `action: "purge"`;
sessionId con patrón cerrado; pertenencia al target revalidada; symlinks
rechazados.

## 17. Comandos prohibidos

La aplicación no ejecuta `rm -rf` genérico, `git clean -fdx`, ni ningún
comando de shell para borrar. Git solo se usa en modo lectura
(`git status --short`). No se ejecutan builds, tests, installs ni comandos
de regeneración (solo se recomiendan). La UI no ejecuta comandos
arbitrarios ni abre terminales.

## 18. Qué hacer ante un incidente

1. Detener el uso de la herramienta.
2. Conservar evidencia: `reports/`, `logs/clean-audit.jsonl`,
   `.repo-cleaner-trash/`, `legacy/` (no borrar nada).
3. Identificar la acción en la auditoría (planId, sessionId, timestamp).
4. Recuperar desde papelera: `restore --session <id> --only <ruta>`
   (o `--on-conflict suffix` si el destino existe).
5. Si Git reporta versionados eliminados, revisar el informe `clean-*.md`
   antes de cualquier commit.
6. Revisar este documento y los tests; proponer cambio mínimo con
   autorización explícita si el comportamiento fuera incorrecto.

## Defensa en profundidad (resumen)

1. Rule engine: riesgo por ruta, con negaciones y reglas por tipo.
2. Loader: validación estricta; protecciones internas siempre fusionadas;
   `.vs` forzado a review.
3. Safety Guard por elemento justo antes de actuar (también con `--yes` y
   permanent); invariantes reaplicadas.
4. Papelera/restore: revalidación de rutas, protegidos y symlinks.
5. UI: límites de red, CSP, validación de rutas/IDs, confirmaciones.
6. Auditoría e informes: trazabilidad completa de cada acción.

# Plan de desarrollo — Repo Cleaner

Repo Cleaner es el módulo de gestión y limpieza de proyectos de **Meridian**.
CLI + UI local segura: escaneo de solo lectura, clasificación por riesgo,
limpieza con confirmación humana obligatoria, papelera reversible,
restauración, purga controlada y auditoría completa.

## Estado actual — v0.4.0

**Fases 1–5 completadas.** Tandas de la fase 5: A (negaciones por tipo),
B (comando trash), C (metadatos de inspección), D1 (informes históricos),
D2 (experiencia de usuario), E1 (empaquetado) y E2 (documentación final).

| Fase | Contenido                                                                                                                                   | Criterio de aceptación                                                                                              | Estado |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| 1    | Tipos, reglas + validación, rule engine, safety guard, scanner, informes JSON/MD, CLI scan/rules                                            | `npm run dev -- scan C:\Trabajo` lista proyectos con tipo/tamaño/artefactos y genera informes sin modificar nada    | ✅     |
| 2    | inspect, clean con human-in-the-loop, papelera, auditoría JSONL, verificación Git, reglas .NET, retirada legacy con backup SHA-256          | clean dry-run no toca nada; confirmación negativa no toca nada; papelera conserva metadatos; protegidos bloqueados  | ✅     |
| 3    | UI web local (Hono + vanilla), API scan/inspect/plan/clean/report/health, solo 127.0.0.1                                                    | `ui C:\Trabajo` sirve la UI en 127.0.0.1:4321; flujo completo por HTTP con confirmación explícita                   | ✅     |
| 4    | restore con conflictos, auditoría de restauración, negaciones globales, UI papelera                                                         | ciclo limpiar→restaurar verificado; overwrite solo con autorización adicional; negaciones nunca debilitan protected | ✅     |
| 5    | trash (purga), projectRules ampliados + detección mejorada, metadatos de inspección, informes históricos UI, UX, empaquetado, documentación | `npm run verify:package` 8/8; `npm link` operativo; 216 tests                                                       | ✅     |

## Funcionalidades implementadas

- **CLI**: `scan`, `inspect`, `clean`, `ui`, `restore`, `trash`, `rules`.
- **Núcleo**: scanner (fast-glob + ignore), project-meta (lenguajes,
  gestores, frameworks, regeneración recomendada, Git solo lectura),
  rule-engine (protected > negación > review > safe), safety guard con
  invariantes, cleaner (plan + confirmación), trash (manifest + hash),
  trash-admin (elegibilidad + purga auditada), restore (conflictos
  cancel/suffix/overwrite), audit JSONL, git (status --short), report
  (JSON/MD/terminal).
- **Reglas**: `config/rules.json` validado; 30 safe, 24 review,
  44 protected; `projectRules` para 10 tipos (alias `node`→`nodejs`);
  `safeNegations` globales y por tipo.
- **UI**: servidor Hono solo 127.0.0.1, Host/Origin locales, CSP estricta,
  frontend vanilla con textContent; vistas inicio/proyectos/inspección/
  plan/resultado/papelera/informes; confirmaciones destructivas con palabra
  clave (PERMANENTE / OVERWRITE); estados vacíos, progreso y errores
  accionables; purga de sesiones desde UI.
- **Empaquetado**: `bin` + `files` + metadatos; `npm link` verificado en
  Windows; `npm run verify:package` (8 comprobaciones); assets UI en dist.
- **Calidad**: TypeScript estricto (noUncheckedIndexedAccess), 216 tests
  Vitest, ESLint 10, Prettier.

## Decisiones técnicas

1. Raíz-proyecto: si la ruta ya es proyecto, análisis único; si no,
   descubrimiento hasta `maxDepth` sin entrar en proyectos detectados.
2. Safe conocido sigue siendo safe aunque sea grande (regenerable por
   definición); `largeThresholdMB` marca review lo grande **sin regla**.
3. Safe no ignorado por `.gitignore` → review (posible contenido
   versionado) + advertencia.
4. Conflictos safe+review → review; desconocido → review; `.vs` siempre
   review (invariante del loader).
5. Negaciones: prioridad sobre safe, nunca sobre protected; directorio
   safe con exclusión literal se degrada y se recorre; negaciones con
   comodín inicial solo aplican a elementos visitados.
6. Guard con `allowReview` solo para selección humana explícita;
   invariantes internas reaplicadas siempre.
7. Papelera dentro del target (o `--trash-dir` validado); rename atómico,
   fallback EXDEV; manifest reescrito tras cada movimiento/restauración;
   sesiones nunca borradas automáticamente.
8. Planes (clean y restore) en memoria con TTL 15 min y consumo único
   garantizado bajo concurrencia (reserva síncrona; 409 a solicitudes
   simultáneas; tests de concurrencia); la acción de ejecución debe
   coincidir con la del plan; overwrite exige confirmación adicional.
9. Auditoría solo metadatos; `clean-audit.jsonl` protegido; se conserva
   tras purgar sesiones.
10. UI sin frameworks; CSP `default-src 'self'`; sin ejecución de comandos;
    informes servidos desde registro/directorio autorizado, solo lectura.
11. Legacy v0 retirado con backup SHA-256 verificado en
    `legacy/v0-backup-20261117-214310/` (evidencia conservada).
12. Detección de frameworks/lenguajes solo con evidencia real; comandos de
    regeneración son recomendaciones, nunca se ejecutan.

## Pendiente / futuro (no implementado)

- Revisión final previa a inicializar Git y primer commit (requiere
  autorización explícita y `operia-code-gate`).
- Posibles mejoras futuras (sin compromiso): reglas negadas en más
  ecosistemas, vista UI de auditoría, restauración selectiva por hash,
  empaquetado instalable adicional.

## Verificación

```bash
npm install
npm run typecheck
npm test                # 216 tests
npm run lint
npm run format
npm run build
npm run verify:package  # 8/8
```

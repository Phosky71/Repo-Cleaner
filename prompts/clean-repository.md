# Tarea: limpiar este repositorio de forma segura

Analiza el repositorio actual y prepara una limpieza segura de artefactos generados.

## Objetivo

Quiero mantener el repositorio limpio, sin builds, cachés, dependencias reinstalables, archivos temporales ni artefactos generados, sin perder código fuente, configuración, secretos, documentación ni trabajo pendiente.

## Pasos

1. Inspecciona el repositorio: raíz, `package.json`, lockfiles, `.gitignore`, scripts, Dockerfiles, frameworks detectados y archivos de configuración.
2. Identifica artefactos regenerables como `node_modules`, `dist`, `build`, `.next`, `.turbo`, `coverage`, `target`, `__pycache__`, `.venv`, logs y archivos temporales.
3. Ejecuta:

```bash
npm install
npm run scan -- . --verbose
```

4. Revisa el informe y clasifica cada elemento:

- **SEGURO**: puede regenerarse con build, test, gestor de paquetes o herramienta conocida.
- **REVISAR**: grande, ambiguo, binario, generado por una herramienta desconocida o potencialmente valioso.
- **PROTEGIDO**: nunca eliminar.

5. Propón un plan de limpieza con:

- Elementos a eliminar.
- Tamaño total liberado.
- Riesgos detectados.
- Comandos exactos que vas a ejecutar.
- Elementos que conservarás y por qué.

6. Espera mi confirmación antes de ejecutar cualquier borrado real.

7. Tras mi confirmación, ejecuta:

```bash
npm run clean -- .
```

8. Verifica después:

```bash
git status --short
npm run typecheck
```

9. Si el proyecto tiene scripts de build, test o lint, propón los comandos adecuados para comprobar que sigue funcionando.

## Restricciones críticas

- No uses `git clean -fdx` sin explicarme exactamente qué eliminaría y obtener confirmación explícita.
- No elimines `.git`, `.github`, `.env`, claves, certificados, bases de datos, backups ni archivos de configuración.
- No elimines nada dentro de `src`, `app`, `lib`, `docs`, `tests` o `test`.
- Si algo no está claro, pregúntame antes de actuar.
- Prioriza siempre seguridad sobre espacio liberado.

## Resultado esperado

Dame primero un informe breve con:

1. Tipo de proyecto detectado.
2. Artefactos seguros encontrados.
3. Artefactos que requieren revisión.
4. Espacio que se liberaría.
5. Plan exacto de limpieza.
6. Confirmación solicitada antes de borrar.

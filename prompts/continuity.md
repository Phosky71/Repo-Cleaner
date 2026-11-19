# Prompt de continuidad para OpenCode

Continúa el desarrollo de **Repo Cleaner** desde el estado actual del repositorio.

## Contexto

Repo Cleaner es una herramienta agéntica para limpiar repositorios de desarrollo sin perder trabajo valioso. Debe ofrecer:

- CLI con `scan`, `clean`, `ui` y `rules`.
- Interfaz web local minimalista.
- Human-in-the-loop obligatorio antes de eliminar.
- Informes JSON y Markdown.
- Reglas configurables en `config/rules.json`.
- Papelera local opcional.
- Auditoría de cada eliminación.

## Instrucción principal

Lee primero estos archivos:

1. `AGENTS.md`
2. `docs/PLAN.md`
3. `docs/SAFETY.md`
4. `config/rules.json`
5. `src/**`
6. `tests/**`

Después, implementa la siguiente fase pendiente del plan, sin saltarte pasos ni inventar funcionalidades.

## Forma de trabajar

1. Inspecciona el estado real del repositorio.
2. Identifica qué está implementado y qué falta.
3. Propón un plan corto para la siguiente fase.
4. Implementa los cambios mínimos necesarios.
5. Ejecuta:

```bash
npm install
npm run typecheck
npm test
npm run lint
```

6. Corrige todos los errores antes de continuar.
7. Actualiza `README.md`, `docs/PLAN.md` y los tests si cambias comportamiento.
8. Al terminar la fase, resume:

- Qué has implementado.
- Qué comandos están disponibles.
- Qué tests cubren el comportamiento.
- Qué riesgos de seguridad has cubierto.
- Qué queda pendiente.

## Prioridad actual

Implementa primero el núcleo seguro:

- Scanner.
- Rule Engine.
- Safety Guard.
- Report Generator.
- CLI `scan`.

Después implementa el human-in-the-loop:

- CLI `clean`.
- Plan previo.
- Confirmación interactiva.
- Papelera local.
- Auditoría.

Después implementa la interfaz web minimalista.

## Restricciones

- No elimines nada del repositorio durante el desarrollo.
- No ejecutes `git clean -fdx`.
- No hagas push sin confirmación.
- No introduzcas dependencias sin justificarlas.
- Mantén TypeScript estricto.
- No dejes TODOs sin implementar si puedes completarlos en la fase actual.
- Si algo requiere una decisión de producto, pregúntame antes de implementarlo.

## Resultado esperado de esta sesión

Al terminar, el comando siguiente debe funcionar de extremo a extremo:

```bash
npm run dev -- scan .
```

Y el comando siguiente debe mostrar un plan y pedir confirmación antes de eliminar:

```bash
npm run dev -- clean .
```

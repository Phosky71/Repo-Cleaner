#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-.}"

echo "Escaneando: $TARGET"
npm run scan -- "$TARGET" --verbose

echo
echo "Para limpiar de verdad:"
echo "npm run clean -- $TARGET"

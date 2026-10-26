#!/usr/bin/env bash
# Setup do ambiente Codex: instala só as dependências do frontend (sem scripts de pós-instalação).
set -euo pipefail

corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile --ignore-scripts

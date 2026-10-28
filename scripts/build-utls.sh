#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
docker build \
  --file "$project_root/.devcontainer/workspace.Dockerfile" \
  --target utls-binary \
  --output "type=local,dest=$project_root/bin" \
  "$project_root"

#!/usr/bin/env bash
# sim/run.sh — the ONE documented command.
#
#   ./sim/run.sh
#
# Builds the pinned image, runs the whole suite in a container, copies the JSON
# report out, and prints the verdict. Exit code: 0 = SIM: CLEAN, 1 = issues
# found, 2 = BLOCKED (the suite could not run — almost always Ollama).
#
# WHY A WRAPPER INSTEAD OF A PLAIN `docker run`. The host-model address differs
# by context: from the HOST, Ollama is localhost:11434; from inside a container
# it is host.docker.internal:11434. Getting that wrong produces a connection
# error that reads like "Ollama is down" when it is running perfectly well, and
# an operator who trusts that message goes and debugs the wrong machine. This
# script owns the difference so the operator does not have to.
set -uo pipefail

IMAGE="polymem-sim:node22.14.0-alpine3.21"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${SIM_OUT_DIR:-$REPO_ROOT/sim-out}"

# ── Preflight, on the HOST ───────────────────────────────────────────────────
# Checked before the build so a down Ollama fails in one second with a real
# message, instead of after a 40-second image build.
if ! curl -sf --max-time 5 http://localhost:11434/api/tags >/dev/null 2>&1; then
  cat >&2 <<'EOF'
SIM: BLOCKED — Ollama is not reachable on http://localhost:11434

The simulation generates every persona with a real model, so there is no
fixture fallback: without a model there is nothing to test, and a harness that
quietly degraded to green would be worse than no harness.

Fix:
  ollama serve                      # start the server
  ollama pull qwen2.5-coder:14b     # make sure the model exists
  ollama ps                         # confirm nothing is mid-load

Then re-run: ./sim/run.sh
EOF
  exit 2
fi

if ! curl -sf --max-time 5 http://localhost:11434/api/tags | grep -q 'qwen2.5-coder:14b'; then
  cat >&2 <<'EOF'
SIM: BLOCKED — Ollama is up but qwen2.5-coder:14b is not installed

  ollama pull qwen2.5-coder:14b

Or point the harness at a model you already have:
  SIM_MODEL=qwen2.5vl:7b ./sim/run.sh
EOF
  exit 2
fi

echo "── building $IMAGE ─────────────────────────────────────────"
docker build -f "$REPO_ROOT/sim/Dockerfile" -t "$IMAGE" "$REPO_ROOT" || exit 1

echo
echo "── running the simulation ──────────────────────────────────"
mkdir -p "$OUT_DIR"

# --add-host is required on Linux daemons; harmless (already present) on Docker
# Desktop. It is not optional: without it the container cannot resolve the host
# name and the failure looks exactly like Ollama being down.
docker run --rm \
  --name polymem-sim \
  --add-host=host.docker.internal:host-gateway \
  -e SIM_DOCKER_IMAGE="$IMAGE" \
  -e SIM_OLLAMA_HOST="${SIM_OLLAMA_HOST:-http://host.docker.internal:11434}" \
  -e SIM_MODEL="${SIM_MODEL:-qwen2.5-coder:14b}" \
  -e SIM_JUDGE_MODEL="${SIM_JUDGE_MODEL:-${SIM_MODEL:-qwen2.5-coder:14b}}" \
  -e SIM_REQUEST_TIMEOUT_MS="${SIM_REQUEST_TIMEOUT_MS:-240000}" \
  -v "$OUT_DIR:/work/out" \
  "$IMAGE"
STATUS=$?

# Pull the report out even on a non-zero exit: a BLOCKED run's report says
# exactly why, and losing it means re-running a 40-second build to read one line.
if [ -f "$OUT_DIR/sim-report.json" ]; then
  cp "$OUT_DIR/sim-report.json" "$REPO_ROOT/sim-report.json"
  echo
  echo "report: $REPO_ROOT/sim-report.json"
else
  echo >&2
  echo "no report was written." >&2
  echo "That means the container exited before the runner saved one — check the" >&2
  echo "output above for the reason (a build or syntax failure, or the container" >&2
  echo "being killed). This is NOT a clean result: nothing was measured." >&2
fi

exit $STATUS

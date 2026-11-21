#!/usr/bin/env bash
# Read-only container health / restart / OOM check. Uses only `docker ps` and
# `docker inspect`. Never stops, starts, recreates or removes anything.
# Fail closed: a failed docker command is reported as unknown, never replaced
# with healthy defaults.
# Exit: 0=ok 1=warn 2=high 3=critical 4=unknown.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

PROJECT="${P7_COMPOSE_PROJECT:-ultrasound-clinic}"
STATE_DIR="$(p7_state_dir)"
RESTART_WARN="${P7_RESTART_DELTA_WARN:-1}"
WORST_FILE="${STATE_DIR}/containers-worst"
# Seed with ok; every unverifiable path below explicitly records rank 4. A
# healthy container must be able to lower the seed to ok, so starting at 4
# would make a healthy run permanently report unknown.
printf '0' >"$WORST_FILE"

if ! lines="$(docker ps -a --filter "name=${PROJECT}" --format '{{.Names}}|{{.Status}}|{{.State}}' 2>/dev/null)"; then
  line="$(p7_emit containers unknown unknown "docker ps failed; container health is unverifiable" "\"project\":\"$(p7_json_escape "$PROJECT")\",\"runbook\":\"docs/monitoring-runbook.md#containers\"")"
  printf '%s\n' "$line"
  p7_alert "$line"
  exit 4
fi

if [ -z "$lines" ]; then
  line="$(p7_emit containers unknown info "no containers matched project ${PROJECT}; check stub or project name" "\"project\":\"$(p7_json_escape "$PROJECT")\",\"runbook\":\"docs/monitoring-runbook.md#containers\"")"
  printf '%s\n' "$line"
  p7_alert "$line"
  exit 4
fi

note_worst() {
  local rank=$1 current
  current="$(cat "$WORST_FILE" 2>/dev/null || printf '4')"
  [ "$rank" -le "$current" ] || printf '%s' "$rank" >"$WORST_FILE"
}

emit_unknown() {
  local check_name=$1 message=$2 name=$3
  local line
  line="$(p7_emit "$check_name" unknown unknown "$message" "\"name\":\"$(p7_json_escape "$name")\",\"runbook\":\"docs/monitoring-runbook.md#containers\"")"
  printf '%s\n' "$line"
  p7_alert "$line"
  note_worst 4
}

while IFS='|' read -r name status_text container_state; do
  [ -n "$name" ] || continue
  if ! inspect="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}' "$name" 2>/dev/null)"; then
    emit_unknown "container:${name}" "docker inspect failed; container health is unverifiable" "$name"
    continue
  fi
  health="$(printf '%s' "$inspect" | awk -F'|' '{print $1}')"
  restarts="$(printf '%s' "$inspect" | awk -F'|' '{print $2}')"
  oom="$(printf '%s' "$inspect" | awk -F'|' '{print $3}')"
  case "$health" in none|healthy|starting|unhealthy) : ;;
    *) emit_unknown "container:${name}" "unexpected docker inspect health value" "$name"; continue ;; esac
  case "$restarts" in ''|*[!0-9]*) emit_unknown "container:${name}" "unexpected docker inspect restart count" "$name"; continue ;; esac
  case "$oom" in true|false) : ;; *) emit_unknown "container:${name}" "unexpected docker inspect OOM value" "$name"; continue ;; esac

  state_file="${STATE_DIR}/restart-${name}"
  previous="0"
  if [ -f "$state_file" ]; then previous="$(cat "$state_file" 2>/dev/null || printf '0')"; fi
  case "$previous" in ''|*[!0-9]*) previous=0 ;; esac
  printf '%s' "$restarts" >"$state_file"
  delta=$((restarts - previous))
  if [ "$delta" -lt 0 ]; then delta=0; fi

  status="ok"; severity="info"; message="container healthy"; rank=0
  if [ "$oom" = "true" ]; then
    status="critical"; severity="page"; message="container was OOM-killed"; rank=3
  elif [ "$container_state" != "running" ] && [[ "$name" != *migrate* ]]; then
    status="critical"; severity="page"; message="container is not running"; rank=3
  elif [ "$health" = "unhealthy" ]; then
    if [[ "$name" == *evolution* ]]; then
      status="warn"; severity="info"; message="Evolution unhealthy (non-blocking; WhatsApp only)"; rank=1
    elif [[ "$name" == *db* || "$name" == *backend* ]]; then
      status="critical"; severity="page"; message="core service unhealthy"; rank=3
    else
      status="high"; severity="warn"; message="service unhealthy"; rank=2
    fi
  elif [ "$delta" -ge "$RESTART_WARN" ]; then
    status="high"; severity="warn"; message="container restarted ${delta} time(s) since last check"; rank=2
  fi

  extra="\"name\":\"$(p7_json_escape "$name")\",\"containerState\":\"$(p7_json_escape "$container_state")\",\"health\":\"$(p7_json_escape "$health")\",\"restartCount\":${restarts},\"restartDelta\":${delta},\"oomKilled\":${oom},\"runbook\":\"docs/monitoring-runbook.md#containers\""
  line="$(p7_emit "container:${name}" "$status" "$severity" "$message" "$extra")"
  printf '%s\n' "$line"
  if [ "$status" != "ok" ]; then p7_alert "$line"; fi
  note_worst "$rank"
done <<<"$lines"

# Recompute the worst status from the state written outside the loop subshell.
worst_rank="$(cat "$WORST_FILE" 2>/dev/null || printf '4')"
case "$worst_rank" in
  4) worst="unknown" ;;
  3) worst="critical" ;;
  2) worst="high" ;;
  1) worst="warn" ;;
  *) worst="ok" ;;
esac
p7_emit "containers" "$worst" "$worst" "container health summary" "\"worst\":\"$(p7_json_escape "$worst")\",\"runbook\":\"docs/monitoring-runbook.md#containers\""
p7_exit_for "$worst"

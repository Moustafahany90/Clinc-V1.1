#!/usr/bin/env bash
# Read-only container health / restart / OOM check. Uses only `docker ps` and
# `docker inspect`. Never stops, starts, recreates or removes anything.
# Exit: 0=ok 1=warn 2=high 3=critical 4=unknown.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

PROJECT="${P7_COMPOSE_PROJECT:-ultrasound-clinic}"
STATE_DIR="$(p7_state_dir)"
RESTART_WARN="${P7_RESTART_DELTA_WARN:-1}"
WORST_FILE="${STATE_DIR}/containers-worst"
printf '0' >"$WORST_FILE"
lines="$(docker ps -a --filter "name=${PROJECT}" --format '{{.Names}}|{{.Status}}|{{.State}}' 2>/dev/null || true)"

if [ -z "$lines" ]; then
  line="$(p7_emit containers unknown info "no containers matched project ${PROJECT}; check stub or project name" "\"project\":\"$(p7_json_escape "$PROJECT")\",\"runbook\":\"docs/monitoring-runbook.md#containers\"")"
  printf '%s\n' "$line"
  p7_alert "$line"
  exit 4
fi

printf '%s\n' "$lines" | while IFS='|' read -r name status_text container_state; do
  [ -n "$name" ] || continue
  inspect="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}' "$name" 2>/dev/null || printf 'none|0|false')"
  health="$(printf '%s' "$inspect" | awk -F'|' '{print $1}')"
  restarts="$(printf '%s' "$inspect" | awk -F'|' '{print $2}')"
  oom="$(printf '%s' "$inspect" | awk -F'|' '{print $3}')"
  [ -n "$health" ] || health="none"
  [ -n "$restarts" ] || restarts="0"
  [ -n "$oom" ] || oom="false"

  state_file="${STATE_DIR}/restart-${name}"
  previous="0"
  if [ -f "$state_file" ]; then previous="$(cat "$state_file" 2>/dev/null || printf '0')"; fi
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

  current="$(cat "$WORST_FILE" 2>/dev/null || printf '0')"
  if [ "$rank" -gt "$current" ]; then printf '%s' "$rank" >"$WORST_FILE"; fi
done

# Recompute the worst status from the state written by the loop, because the
# loop runs in a subshell under `pipefail`.
worst_rank="$(cat "$WORST_FILE" 2>/dev/null || printf '0')"
case "$worst_rank" in
  3) worst="critical" ;;
  2) worst="high" ;;
  1) worst="warn" ;;
  *) worst="ok" ;;
esac
p7_emit "containers" "$worst" "$worst" "container health summary" "\"worst\":\"$(p7_json_escape "$worst")\",\"runbook\":\"docs/monitoring-runbook.md#containers\""
p7_exit_for "$worst"

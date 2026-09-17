#!/usr/bin/env bash
set -Eeuo pipefail
trap 'printf "watch-with-me: error on line %s (exit %s)\n" "$LINENO" "$?" >&2' ERR

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
COMPOSE=(docker compose -f "$ROOT_DIR/docker-compose.yml")
TIMEOUT="${WATCH_WITH_ME_TIMEOUT:-120}"
SERVICES=(postgres redis minio livekit coturn media-worker realtime web)

die() { printf 'watch-with-me: %s\n' "$*" >&2; exit 1; }
resolve_livekit_node_ip() {
  if [[ "${LIVEKIT_NODE_IP:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ && ! "${LIVEKIT_NODE_IP}" =~ ^(127\.|169\.254\.|0\.) ]]; then printf '%s' "$LIVEKIT_NODE_IP"; return; fi
  local ip=''
  if command -v ip >/dev/null 2>&1; then ip="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([^ ]*\).*/\1/p' | head -n1)"; fi
  if [[ -z "$ip" ]] && command -v hostname >/dev/null 2>&1; then ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | sed -n '/^[0-9]\{1,3\}\./{/^127\./d;/^169\.254\./d;p;}' | head -n1)"; fi
  [[ -n "$ip" ]] || die 'could not detect a LAN IPv4 address; set LIVEKIT_NODE_IP explicitly.'
  printf '%s' "$ip"
}
resolve_docker_host_network_ip() {
  if [[ "${DOCKER_HOST_NETWORK_IP:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ && ! "${DOCKER_HOST_NETWORK_IP}" =~ ^(127\.|169\.254\.|0\.) ]]; then printf '%s' "$DOCKER_HOST_NETWORK_IP"; return; fi
  local ip; ip="$(docker run --rm --network host --entrypoint sh alpine:3.20 -c 'ip -4 route get 1.1.1.1 | sed -n "s/.* src \([^ ]*\).*/\1/p"' 2>/dev/null | head -n1)"
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ && ! "$ip" =~ ^(127\.|169\.254\.|0\.) ]] || die 'could not detect Docker host-network IPv4; set DOCKER_HOST_NETWORK_IP explicitly.'
  printf '%s' "$ip"
}
set_livekit_network() { export LIVEKIT_NODE_IP="$(resolve_livekit_node_ip)"; export DOCKER_HOST_NETWORK_IP="$(resolve_docker_host_network_ip)"; printf 'watch-with-me: LiveKit LAN IPv4=%s; Docker host-network IPv4=%s (override with LIVEKIT_NODE_IP/DOCKER_HOST_NETWORK_IP).\n' "$LIVEKIT_NODE_IP" "$DOCKER_HOST_NETWORK_IP"; }
usage() {
  cat <<'EOF'
Usage: watch-with-me <command>
  start [--no-build] | stop | restart [--no-build] | status | health
  logs [web|realtime|postgres|redis|minio|livekit|coturn|media-worker] [--follow] [--tail N]
  remove | clean [--yes] | test | doctor | help
EOF
}
run_compose() { "${COMPOSE[@]}" "$@"; }
preflight() {
  command -v docker >/dev/null 2>&1 || die 'Docker CLI is not available.'
  docker info >/dev/null 2>&1 || die 'Docker daemon is unavailable; start Docker and retry.'
  [[ -n "${LIVEKIT_NODE_IP:-}" && -n "${DOCKER_HOST_NETWORK_IP:-}" ]] || set_livekit_network
  run_compose config >/dev/null || die 'docker-compose.yml is invalid or unavailable.'
}
service_health() {
  local service="$1" id state
  id="$(run_compose ps -q "$service")" || return 1
  [[ -n "$id" ]] || return 1
  state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
  [[ "$state" == healthy ]]
}
wait_ready() {
  local end=$((SECONDS + TIMEOUT)) service
  until (( SECONDS >= end )); do
    if service_health postgres && service_health redis && service_health minio && service_health livekit && service_health coturn && service_health media-worker && service_health realtime && service_health web; then
      if command -v curl >/dev/null 2>&1 && curl --silent --show-error --fail --max-time 3 http://127.0.0.1:3000/ >/dev/null; then
        printf 'watch-with-me: all services healthy and web is responding (within %ss).\n' "$TIMEOUT"; return 0
      fi
    fi
    sleep 2
  done
  printf 'watch-with-me: timed out after %ss waiting for service health/HTTP.\n' "$TIMEOUT" >&2
  run_compose ps
  return 1
}
valid_service() { case "$1" in web|realtime|postgres|redis|minio|livekit|coturn|media-worker) return 0;; *) return 1;; esac; }
doctor() {
  command -v docker >/dev/null 2>&1 || die 'Docker CLI is not available.'
  docker info >/dev/null 2>&1 || die 'Docker daemon is unavailable.'
  run_compose config >/dev/null || die 'Compose configuration failed.'
  local port; for port in 3000 4000; do
    if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Ports}}' | grep -Eq "(^|[^0-9])127\.0\.0\.1:${port}->|0\.0\.0\.0:${port}->|:::${port}->"; then
      printf 'doctor: port %s is already published by a Docker container (no process will be killed).\n' "$port" >&2
    fi
    if command -v ss >/dev/null 2>&1 && ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .; then
      printf 'doctor: port %s is occupied by a listening host process (no process will be killed).\n' "$port" >&2
    elif command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | grep -q .; then
      printf 'doctor: port %s is occupied by a listening host process (no process will be killed).\n' "$port" >&2
    fi
  done
  printf 'doctor: Docker, daemon, compose configuration, and port checks passed.\n'
}

command_name="${1:-help}"; shift || true
case "$command_name" in
  help|-h|--help) usage ;;
  doctor) set_livekit_network; doctor ;;
  config) preflight; run_compose config ;;
  start)
    set_livekit_network; preflight; build=1; [[ "${1:-}" == --no-build ]] && { build=0; shift; }; [[ $# -eq 0 ]] || die 'start accepts only --no-build.'
    (( build )) && run_compose up --build -d || run_compose up -d; wait_ready ;;
  stop) preflight; [[ $# -eq 0 ]] || die 'stop takes no arguments.'; run_compose stop ;;
  restart) set_livekit_network; preflight; build=1; [[ "${1:-}" == --no-build ]] && { build=0; shift; }; [[ $# -eq 0 ]] || die 'restart accepts only --no-build.'; run_compose stop; (( build )) && run_compose up --build -d || run_compose up -d; wait_ready ;;
  status) preflight; [[ $# -eq 0 ]] || die 'status takes no arguments.'; run_compose ps ;;
  health) preflight; [[ $# -eq 0 ]] || die 'health takes no arguments.'; wait_ready ;;
  logs)
    preflight; service="${1:-}"; valid_service "$service" || die 'logs requires one allowed service: web, realtime, postgres, redis, minio, livekit, coturn, media-worker.'; shift
    follow=0; tail=100
    while (($#)); do case "$1" in --follow) follow=1;; --tail) shift; [[ "${1:-}" =~ ^[0-9]+$ ]] || die '--tail requires a non-negative integer.'; tail="$1";; *) die 'unknown logs option.';; esac; shift; done
    args=(logs --tail "$tail"); (( follow )) && args+=(--follow); args+=("$service"); run_compose "${args[@]}" ;;
  remove) preflight; [[ $# -eq 0 ]] || die 'remove takes no arguments.'; run_compose down --remove-orphans ;;
  clean) preflight; yes=0; [[ "${1:-}" == --yes ]] && { yes=1; shift; }; [[ $# -eq 0 ]] || die 'clean accepts only --yes.'; if (( ! yes )); then read -r -p 'Type DELETE to remove containers, networks, and volumes: ' answer; [[ "$answer" == DELETE ]] || die 'clean cancelled.'; fi; run_compose down --volumes --remove-orphans ;;
  test) set_livekit_network; preflight; wait_ready; command -v npm >/dev/null 2>&1 || die 'npm is not available; install Node.js/npm before running Docker E2E tests.'; grep -q '"test:e2e:docker"' "$ROOT_DIR/package.json" || die 'npm script test:e2e:docker is not present yet; do not run test until it is added.'; npm --prefix "$ROOT_DIR" run test:e2e:docker ;;
  *) die "unknown command '$command_name'; use help." ;;
esac

#!/usr/bin/env bash
# aiqsa.sh: operator CLI for the AIQSA production Compose stack.
#
# Usage: ./aiqsa.sh <command> [options]; ./aiqsa.sh help lists commands and flags.
#
# Exit codes: 0 ok, 1 failure, 2 usage, 3 unsupported host, 4 preflight or
# doctor check failed (install/up/upgrade/backup/restore: before any container
# change), 5 stack not ready (Compose up failed, the wait timed out or the
# post-start check failed), 6 upgrade refused.
#
# The project directory is the directory containing this script. Compose
# chooses the project name (COMPOSE_PROJECT_NAME, else `name:` in compose.yaml).
# The CLI never sources .env, never prints its values, never runs sudo, never
# runs `docker compose down` on the installation's project (restore only removes
# its own isolated aiqsa-restore-* project) and never changes sysctls, groups or
# packages.
#
# `backup` is a cold copy: application writers and object storage stop while
# PostgreSQL and the bundled object volume are copied, and a trap restarts
# exactly the services that were running on any failure or interrupt.
# `restore` only fills an empty installation of the same version, reconciling
# in an isolated internal project before anything of the real project starts.
#
# Test-only hooks; never set them on a real installation:
#   AIQSA_CLI_KVM_DEVICE        KVM device path (default /dev/kvm)
#   AIQSA_CLI_PROC_ROOT         proc root for meminfo and cpuinfo (default /proc)
#   AIQSA_CLI_RESTORE_OVERRIDE  extra Compose file appended to the isolated
#                               restore project (for example explicit subnets
#                               on hosts without free Docker address pools)
#
# `upgrade` re-executes the updated script as
#   aiqsa.sh __upgrade-apply --previous-ref <commit> [options]
# Keep that internal interface stable across releases.

# Plain POSIX guard so `sh aiqsa.sh` explains itself instead of failing to parse.
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s\n' 'aiqsa.sh requires bash 4 or newer: run ./aiqsa.sh or bash aiqsa.sh.' >&2
  exit 3
fi
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  printf '%s\n' "aiqsa.sh requires bash 4 or newer; found $BASH_VERSION." >&2
  exit 3
fi

set -euo pipefail
IFS=$' \t\n'

readonly EXIT_FAILURE=1 EXIT_USAGE=2 EXIT_UNSUPPORTED=3 EXIT_PREFLIGHT=4 EXIT_NOT_READY=5 EXIT_REFUSED=6
readonly COMPOSE_FLOOR=2.29.7 ENGINE_TECHNICAL_FLOOR=20.10 ENGINE_SUPPORTED_FLOOR=25.0
readonly MAX_MAP_COUNT_FLOOR=262144
readonly MEMORY_FAIL_KIB=7549747 MEMORY_WARN_KIB=15099494   # 90% of 8 GiB and 16 GiB
readonly DISK_WARN_KIB=48828125                              # 50 GB
readonly REPOSITORY_URL=https://github.com/insciqq/AIQSA
readonly LEGACY_RUNBOOK_URL=$REPOSITORY_URL/blob/v0.2.34/UPGRADING_FROM_MINIO.md
readonly RUNNER_URL_DEFAULT=http://workspace-runner:4310
readonly LOG_TAIL_LINES=60 LOGS_DEFAULT_TAIL=200

PROJECT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly PROJECT_DIR
readonly KVM_DEVICE=${AIQSA_CLI_KVM_DEVICE:-/dev/kvm}
readonly PROC_ROOT=${AIQSA_CLI_PROC_ROOT:-/proc}
RESTORE_OVERRIDE_HOOK=${AIQSA_CLI_RESTORE_OVERRIDE:-}
readonly BACKUP_FORMAT=1
# Services that keep running while the backup stops application writers.
readonly BACKUP_KEEP_RUNNING=" postgres opensearch seaweedfs minio docling tika workspace-runner "
readonly ONE_SHOT_SERVICES=" migrate-bootstrap storage-init "
readonly KEY_ID_PATTERN='^[a-z][a-z0-9_-]{0,63}$'

# Options.
COMMAND=""
YES=0 QUIET=0 VERBOSE=0 TIMEOUT=600
ENV_FILE="" BASE_URL="" ADMIN_EMAIL="" WORKSPACE_MODE=""
HOST_ONLY=0 STACK_ONLY=0 NO_START=0 SKIP_PREFLIGHT=0 HELP=0
TARGET_TAG="" BACKUP_CONFIRMED=0 BACKUP_NOW=0 ADD_MISSING_KEYS=0 PREVIOUS_REF=""
OUTPUT_DIR="" RESTORE_DIR=""
LOGS_ERRORS=0 LOGS_WARNINGS=0 LOGS_FOLLOW=0 LOGS_TAIL="" LOG_SERVICES=()
# --since: a log window for logs, a Health range for health.
SINCE="" HEALTH_JSON=0 HEALTH_RUN="" HEALTH_FULL=0 HEALTH_USER=""
declare -A GIVEN=()

# State.
declare -A ENV_VALUES=()
ENV_INVALID_LINES=0
MASK_VALUES=() MASK_PENDING=()
COMPOSE_ENV_ARGS=()
TEMP_DIR="" CONFIGURE_TMP=""
PASS_COUNT=0 WARN_COUNT=0 FAIL_COUNT=0
DOCKER_STATE="" DOCKER_SERVER_VERSION="" DOCKER_ERROR=""
PROJECT_NAME=""
KVM_OK=0 KVM_GID="" KVM_REASON="" KVM_VIRT=""
COLOR=0
# Backup: the writers are stopped while BACKUP_STOPPED=1; RESTART_SERVICES is
# exactly the set that was running before. BACKUP_CONTEXT=upgrade turns every
# backup failure into an upgrade refusal (exit 6).
BACKUP_STOPPED=0 BACKUP_DIR="" BACKUP_CREATED_DIR=0 BACKUP_COMPLETE=0 BACKUP_CONTEXT=backup
RESTART_SERVICES=()
# Restore: RESTORE_PHASE is "isolated" from publishing .env until the real
# project starts; RC_ARGS selects the isolated aiqsa-restore-* project.
RESTORE_PHASE="" RESTORE_PROJECT="" RESTORE_OVERRIDE="" RESTORE_KVM_GID="" RESTORE_KVM_GID_FROM=""
RC_ARGS=()

# ---------------------------------------------------------------- output

if [[ -t 1 && -z ${NO_COLOR:-} && ${TERM:-dumb} != dumb ]]; then COLOR=1; fi
# fd 3 and 4 keep the original stderr and stdout for traces and exit handling.
exec 3>&2 4>&1

say() { (( QUIET )) || printf '%s\n' "$@"; }
note() { printf '%s\n' "$@" >&2; }
die() { local code=$1; shift; printf '%s\n' "$@" | mask_stream >&2; exit "$code"; }

paint() {
  local level=$1
  if (( ! COLOR )); then printf '%s' "$level"; return; fi
  case $level in
    PASS) printf '\033[32m%s\033[0m' "$level" ;;
    WARN) printf '\033[33m%s\033[0m' "$level" ;;
    FAIL) printf '\033[31m%s\033[0m' "$level" ;;
    *) printf '%s' "$level" ;;
  esac
}

# check LEVEL NAME DETAIL [REMEDY...]: one doctor line plus indented remedies.
check() {
  local level=$1 name=$2 detail=$3 remedy
  shift 3
  case $level in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    WARN) WARN_COUNT=$((WARN_COUNT + 1)) ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
  esac
  if (( QUIET )) && [[ $level == PASS || $level == INFO ]]; then return 0; fi
  {
    printf '%s %s: %s\n' "$(paint "$level")" "$name" "$detail"
    for remedy in "$@"; do printf '%s\n' "$remedy" | sed 's/^/  /'; done
  } | mask_stream
}

# Traces go to fd 3 (the original stderr) so redirected commands still show them.
run() {
  if (( VERBOSE )); then printf '+ %s\n' "$*" >&3; fi
  "$@" 3>&- 4>&-
}

# Replaces every non-empty secret-like .env value with ***.
mask_stream() {
  local line secret
  while IFS= read -r line || [[ -n $line ]]; do
    for secret in ${MASK_VALUES[@]+"${MASK_VALUES[@]}"}; do
      line=${line//"$secret"/***}
    done
    printf '%s\n' "$line"
  done
}

secret_like() {
  case $1 in
    *SECRET* | *PASSWORD* | *KEY* | *TOKEN*) return 0 ;;
    *) return 1 ;;
  esac
}

# Call directly, never in $(...), so the directory is created once and removed on exit.
ensure_temp_dir() {
  if [[ -z $TEMP_DIR ]]; then TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/aiqsa-cli.XXXXXX"); fi
}

cleanup() {
  if [[ -n $TEMP_DIR ]]; then rm -rf -- "$TEMP_DIR"; fi
  if [[ -n $CONFIGURE_TMP ]]; then rm -f -- "$CONFIGURE_TMP"; fi
}

# Any exit, including errors and interrupts, first restarts writers a backup
# stopped and explains how to discard an unfinished restore.
on_exit() {
  local status=$? code=0
  set +e
  # An interrupt is handled inside the interrupted command's redirections.
  exec 1>&4 2>&3
  backup_discard
  if (( BACKUP_STOPPED )); then
    BACKUP_STOPPED=0
    note "Restarting the services that were stopped for the backup."
    ( backup_restart )
    code=$?
    (( code == 0 )) || status=$code
  fi
  if [[ $RESTORE_PHASE == isolated ]] && (( status )); then restore_abort; fi
  cleanup
  exit "$status"
}
trap on_exit EXIT
trap 'exit 1' HUP INT TERM

# ---------------------------------------------------------------- .env

# Strict KEY=VALUE reader: never evaluates anything. Strips one pair of
# matching surrounding quotes; otherwise drops a ` #` comment after the value.
env_unquote() {
  local value=$1 first last inner after
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  first=${value:0:1}
  last=${value: -1}
  if [[ $first == '"' || $first == "'" ]]; then
    if [[ ${#value} -ge 2 && $last == "$first" ]]; then
      REPLY=${value:1:${#value}-2}
      return
    fi
    inner=${value:1}
    after=${inner#*"$first"}
    if [[ $inner == *"$first"* && $after =~ ^[[:space:]]+#.*$ ]]; then
      REPLY=${inner%%"$first"*}
      return
    fi
  elif [[ $value =~ ^(.*[^[:space:]])[[:space:]]+#.*$ ]]; then
    value=${BASH_REMATCH[1]}
  fi
  REPLY=$value
}

env_load() {
  local line key
  ENV_VALUES=()
  ENV_INVALID_LINES=0
  [[ -f $ENV_FILE ]] || return 0
  env_readable_or_die
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      key=${BASH_REMATCH[2]}
      env_unquote "${BASH_REMATCH[3]}"
      ENV_VALUES[$key]=$REPLY
    else
      ENV_INVALID_LINES=$((ENV_INVALID_LINES + 1))
    fi
  done < "$ENV_FILE"
  mask_refresh
}

# A root-owned .env (for example after `sudo ./aiqsa.sh install`) must not end
# in a raw bash redirection error.
env_readable_or_die() {
  [[ -r $ENV_FILE ]] && return 0
  local owner mode shown
  owner=$(stat -c %U -- "$ENV_FILE" 2>/dev/null) || owner=unknown
  mode=$(stat -c %a -- "$ENV_FILE" 2>/dev/null) || mode=unknown
  shown=$(display_path "$ENV_FILE")
  die "$EXIT_FAILURE" "$shown is not readable by $(id -un) (owner $owner, mode $mode)." \
    "Run ./aiqsa.sh as $owner, or take ownership: sudo chown \"\$(id -un)\": $(printf '%q' "$shown")"
}

# mask_add KEY VALUE: queues VALUE for masking when KEY looks secret.
mask_add() {
  local entry entries
  if [[ -z $2 ]] || ! secret_like "$1"; then return 0; fi
  MASK_PENDING+=("$2")
  # Keyrings (current=v1,v1=<key>,...) also mask each key on its own.
  if [[ $1 == *KEYRING* ]]; then
    IFS=',' read -r -a entries <<< "$2"
    for entry in ${entries[@]+"${entries[@]}"}; do
      if [[ $entry == *=* && ${#entry} -gt 16 ]]; then MASK_PENDING+=("${entry#*=}"); fi
    done
  fi
}

mask_refresh() {
  local key name
  MASK_PENDING=()
  for key in "${!ENV_VALUES[@]}"; do mask_add "$key" "${ENV_VALUES[$key]}"; done
  while IFS= read -r name; do
    if [[ $name == AIQSA_* ]]; then mask_add "$name" "${!name:-}"; fi
  done < <(compgen -e)
  MASK_VALUES=()
  if (( ${#MASK_PENDING[@]} )); then
    # Longest first, so a secret containing another is masked whole.
    mapfile -t MASK_VALUES < <(printf '%s\n' "${MASK_PENDING[@]}" | awk '{ print length($0) "\t" $0 }' | sort -rn | cut -f2-)
  fi
}

# Effective value as Compose interpolates it: process environment, then .env.
env_value() {
  local key=$1
  if [[ -n ${!key+set} ]]; then printf '%s' "${!key}"; else printf '%s' "${ENV_VALUES[$key]:-}"; fi
}

profile_enabled() {
  local profiles profile
  profiles=$(env_value COMPOSE_PROFILES)
  IFS=',' read -r -a profiles <<< "$profiles"
  for profile in ${profiles[@]+"${profiles[@]}"}; do
    profile=${profile//[[:space:]]/}
    [[ $profile == "$1" ]] && return 0
  done
  return 1
}

# Workspace is part of every supported installation; only an existing .env
# (or configure --workspace off for disposable tests) can leave it out.
workspace_expected() {
  if [[ -f $ENV_FILE ]]; then profile_enabled workspace; else [[ ${WORKSPACE_MODE:-on} != off ]]; fi
}

valid_base_url() {
  [[ $1 =~ ^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?/?$ ]]
}

valid_email() {
  [[ $1 =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]
}

loopback_address() {
  case $1 in 127.* | localhost | ::1 | '[::1]') return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------- versions

version_triplet() {
  local raw=${1#v} major minor patch
  raw=${raw%%[-+ ]*}
  IFS=. read -r major minor patch _ <<< "$raw"
  printf '%d %d %d' "$((10#${major:-0}))" "$((10#${minor:-0}))" "$((10#${patch:-0}))" 2>/dev/null
}

# version_ge A B: A >= B for dotted numeric versions.
version_ge() {
  local a b
  read -r -a a <<< "$(version_triplet "$1")" || return 1
  read -r -a b <<< "$(version_triplet "$2")" || return 1
  local index
  for index in 0 1 2; do
    if (( ${a[index]:-0} > ${b[index]:-0} )); then return 0; fi
    if (( ${a[index]:-0} < ${b[index]:-0} )); then return 1; fi
  done
  return 0
}

numeric_version() { [[ ${1#v} =~ ^[0-9]+(\.[0-9]+){1,2}([-+].*)?$ ]]; }

package_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# ---------------------------------------------------------------- docker

dc() {
  run docker compose --project-directory "$PROJECT_DIR" ${COMPOSE_ENV_ARGS[@]+"${COMPOSE_ENV_ARGS[@]}"} "$@"
}

docker_probe() {
  [[ -n $DOCKER_STATE ]] && return 0
  if ! command -v docker >/dev/null 2>&1; then DOCKER_STATE=missing; return 0; fi
  local errors
  ensure_temp_dir
  errors=$TEMP_DIR/docker-version.err
  if DOCKER_SERVER_VERSION=$(run docker version --format '{{.Server.Version}}' 2>"$errors") \
    && [[ -n $DOCKER_SERVER_VERSION ]]; then
    DOCKER_STATE=ok
    return 0
  fi
  DOCKER_ERROR=$(head -n 1 "$errors" | mask_stream)
  DOCKER_ERROR=${DOCKER_ERROR:-docker version failed without an error message}
  case ${DOCKER_ERROR,,} in
    *"permission denied"*) DOCKER_STATE=denied ;;
    *"cannot connect to the docker daemon"* | *"is the docker daemon running"* | *"connection refused"* | *"no such file or directory"*)
      DOCKER_STATE=down ;;
    *) DOCKER_STATE=error ;;
  esac
}

docker_ready() { docker_probe; [[ $DOCKER_STATE == ok ]]; }

# Sets PROJECT_NAME as Compose resolves it; call directly, not in $(...).
load_project_name() {
  [[ -z $PROJECT_NAME ]] || return 0
  # The JSON carries resolved secrets: it is only piped to sed, never shown.
  PROJECT_NAME=$(dc config --format json 2>/dev/null \
    | sed -n 's/^  "name": "\([^"]*\)",\{0,1\}$/\1/p' | head -n 1) || PROJECT_NAME=""
}

# ---------------------------------------------------------------- host facts

kvm_probe() {
  local cpu_flags=1 mode group_digit arch
  KVM_OK=0 KVM_GID="" KVM_REASON=""
  KVM_VIRT=$(systemd-detect-virt 2>/dev/null || true)
  KVM_VIRT=${KVM_VIRT:-unknown}
  arch=$(uname -m)
  if [[ $arch == x86_64 || $arch == i?86 ]] && ! grep -Eqw 'vmx|svm' "$PROC_ROOT/cpuinfo" 2>/dev/null; then
    cpu_flags=0
  fi
  if [[ ! -e $KVM_DEVICE ]]; then
    if [[ $KVM_VIRT != none && $KVM_VIRT != unknown ]]; then
      KVM_REASON="$KVM_DEVICE is missing: this host is a virtual machine ($KVM_VIRT) without nested virtualization"
    elif (( ! cpu_flags )); then
      KVM_REASON="$KVM_DEVICE is missing and the CPU virtualization flags (vmx/svm) are not visible: enable VT-x/AMD-V in the firmware, or nested virtualization when this is a virtual machine"
    else
      KVM_REASON="$KVM_DEVICE is missing: load the kvm_intel or kvm_amd kernel module"
    fi
    return 0
  fi
  KVM_GID=$(stat -c %g -- "$KVM_DEVICE")
  mode=$(stat -c %a -- "$KVM_DEVICE")
  group_digit=${mode: -2:1}
  if [[ $group_digit != [67] ]]; then
    KVM_REASON="$KVM_DEVICE (group $KVM_GID, mode $mode) is not readable and writable by its group"
    return 0
  fi
  KVM_OK=1
}

workspace_lines() {
  printf '%s\n' \
    "COMPOSE_PROFILES=workspace" \
    "AIQSA_WORKSPACE_RUNNER_URL=$RUNNER_URL_DEFAULT" \
    "AIQSA_WORKSPACE_RUNNER_TOKEN=<new value from: openssl rand -hex 32>" \
    "AIQSA_KVM_GID=${KVM_GID:-<group of $KVM_DEVICE: stat -c %g $KVM_DEVICE>}"
}

kvm_required_help() {
  printf '%s\n' "Workspace runs commands in KVM virtual machines and most of AIQSA depends on it, so installations without a usable $KVM_DEVICE are not supported." \
    "On cloud and other virtual machines enable nested virtualization for the VM, or use a bare-metal host; ./aiqsa.sh doctor shows the KVM checks."
}

# ---------------------------------------------------------------- doctor: host

doctor_host() {
  local os arch detail
  os=$(uname -s)
  arch=$(uname -m)
  if [[ $os != Linux ]]; then
    die "$EXIT_UNSUPPORTED" "Unsupported host: $os. AIQSA's production stack runs on 64-bit Linux."
  fi
  detail="$os $arch"
  if [[ -r /etc/os-release ]]; then
    detail+=" ($(sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release | head -n 1))"
  fi
  case $arch in
    x86_64 | aarch64 | arm64) check PASS os "$detail" ;;
    *) check FAIL os "$detail" "AIQSA images are published for amd64 and arm64 only." ;;
  esac
  check PASS bash "$BASH_VERSION"
  if command -v git >/dev/null 2>&1; then
    check PASS git "$(git --version 2>/dev/null | head -n 1)"
  else
    check WARN git "not found" "Install git; ./aiqsa.sh upgrade needs it."
  fi
  if command -v openssl >/dev/null 2>&1; then
    check PASS openssl "found"
  elif [[ -f $ENV_FILE ]]; then
    check WARN openssl "not found" "Install OpenSSL; generating new keys needs it."
  else
    check FAIL openssl "not found" "Install OpenSSL; it generates the installation secrets."
  fi
  doctor_docker
  doctor_sysctl
  doctor_memory
  doctor_disk
  doctor_time
  doctor_port
  doctor_kvm
}

doctor_docker() {
  docker_probe
  case $DOCKER_STATE in
    missing)
      check FAIL docker "Docker is not installed" "Install Docker Engine: https://docs.docker.com/engine/install/" ;;
    denied)
      check FAIL docker "permission denied on the Docker socket" \
        "Add your user to the docker group: sudo usermod -aG docker \"\$USER\", then log out and back in." \
        "Alternatively run ./aiqsa.sh as root." ;;
    down)
      check FAIL docker "the Docker daemon is not running or unreachable${DOCKER_HOST:+ at DOCKER_HOST}" \
        "Start it: sudo systemctl enable --now docker" ;;
    error)
      check FAIL docker "the Docker daemon did not answer: $DOCKER_ERROR" ;;
    ok)
      if ! numeric_version "$DOCKER_SERVER_VERSION"; then
        check WARN docker "Engine version '$DOCKER_SERVER_VERSION' is not recognised"
      elif ! version_ge "$DOCKER_SERVER_VERSION" "$ENGINE_TECHNICAL_FLOOR"; then
        check FAIL docker "Engine $DOCKER_SERVER_VERSION is too old" "Upgrade Docker Engine to $ENGINE_SUPPORTED_FLOOR or newer."
      elif ! version_ge "$DOCKER_SERVER_VERSION" "$ENGINE_SUPPORTED_FLOOR"; then
        check WARN docker "Engine $DOCKER_SERVER_VERSION is unsupported (end of life, untested)" "Upgrade Docker Engine to $ENGINE_SUPPORTED_FLOOR or newer."
      else
        check PASS docker "Engine $DOCKER_SERVER_VERSION"
      fi ;;
  esac
  [[ $DOCKER_STATE == missing ]] && return 0
  local compose_version
  if compose_version=$(run docker compose version --short 2>/dev/null) && [[ -n $compose_version ]]; then
    compose_version=${compose_version#v}
    if numeric_version "$compose_version" && version_ge "$compose_version" "$COMPOSE_FLOOR"; then
      check PASS compose "Compose $compose_version"
    else
      check FAIL compose "Compose $compose_version is older than $COMPOSE_FLOOR" \
        "Upgrade the Docker Compose plugin: https://docs.docker.com/compose/install/linux/"
    fi
  elif command -v docker-compose >/dev/null 2>&1; then
    check FAIL compose "only Compose v1 (docker-compose) is installed" \
      "Install the Compose v2 plugin ($COMPOSE_FLOOR or newer): https://docs.docker.com/compose/install/linux/"
  else
    check FAIL compose "the docker compose plugin is not installed" \
      "Install the Compose v2 plugin ($COMPOSE_FLOOR or newer): https://docs.docker.com/compose/install/linux/"
  fi
}

doctor_sysctl() {
  local value
  value=$(sysctl -n vm.max_map_count 2>/dev/null) || value=$(cat "$PROC_ROOT/sys/vm/max_map_count" 2>/dev/null) || value=""
  if [[ ! $value =~ ^[0-9]+$ ]]; then
    check WARN vm.max_map_count "could not be read" "OpenSearch needs vm.max_map_count >= $MAX_MAP_COUNT_FLOOR."
  elif (( value < MAX_MAP_COUNT_FLOOR )); then
    check FAIL vm.max_map_count "$value is below $MAX_MAP_COUNT_FLOOR; OpenSearch will not start" \
      "sudo sysctl -w vm.max_map_count=$MAX_MAP_COUNT_FLOOR" \
      "echo 'vm.max_map_count=$MAX_MAP_COUNT_FLOOR' | sudo tee /etc/sysctl.d/99-aiqsa.conf"
  else
    check PASS vm.max_map_count "$value"
  fi
}

doctor_memory() {
  local kib cpus
  kib=$(sed -n 's/^MemTotal:[[:space:]]*\([0-9]*\) kB$/\1/p' "$PROC_ROOT/meminfo" 2>/dev/null | head -n 1) || kib=""
  if [[ ! $kib =~ ^[0-9]+$ ]]; then
    check WARN memory "could not read $PROC_ROOT/meminfo"
  else
    local gib="$((kib / 1048576)).$(((kib % 1048576) * 10 / 1048576)) GiB"
    if (( kib < MEMORY_FAIL_KIB )); then
      check FAIL memory "$gib; at least 8 GB is required (each Workspace session runs in a 4 GB virtual machine)"
    elif (( kib < MEMORY_WARN_KIB )); then
      check WARN memory "$gib; 16 GB is recommended for several Workspace sessions, Knowledge ingestion and OCR"
    else
      check PASS memory "$gib"
    fi
  fi
  cpus=$(grep -c '^processor' "$PROC_ROOT/cpuinfo" 2>/dev/null) || cpus=0
  if (( cpus >= 2 )); then
    check PASS cpus "$cpus"
  else
    check WARN cpus "${cpus:-unknown}; at least 2 cores are recommended"
  fi
}

doctor_disk() {
  docker_ready || return 0
  local root available
  root=$(run docker info --format '{{.DockerRootDir}}' 2>/dev/null) || root=""
  if [[ -z $root ]]; then
    check WARN disk "the Docker root directory is unknown"
    return 0
  fi
  available=$(df -Pk -- "$root" 2>/dev/null | awk 'NR == 2 { print $4 }') || available=""
  if [[ ! $available =~ ^[0-9]+$ ]]; then
    check WARN disk "free space in $root could not be read"
  elif (( available < DISK_WARN_KIB )); then
    check WARN disk "$((available / 1000000)) GB free in $root; 50 GB is recommended" \
      "Free space or move the Docker root directory before uploads and images fill it."
  else
    check PASS disk "$((available / 1000000)) GB free in $root"
  fi
}

doctor_time() {
  command -v timedatectl >/dev/null 2>&1 || return 0
  local synced
  synced=$(timedatectl show -p NTPSynchronized --value 2>/dev/null) || return 0
  case $synced in
    yes) check PASS time "NTP synchronised" ;;
    no) check WARN time "the clock is not NTP synchronised; TLS and OAuth need a correct clock" \
      "sudo timedatectl set-ntp true" ;;
  esac
}

# Prints the local addresses listening on PORT.
port_listeners() {
  local port=$1 probe=$2 local_address timer=()
  if command -v ss >/dev/null 2>&1; then
    while read -r _ _ _ local_address _; do
      if [[ ${local_address##*:} == "$port" ]]; then printf '%s\n' "${local_address%:*}"; fi
    done < <(ss -Hltn 2>/dev/null)
    return 0
  fi
  if command -v timeout >/dev/null 2>&1; then timer=(timeout 3); fi
  # shellcheck disable=SC2016 # $1 and $2 expand in the child shell.
  if run ${timer[@]+"${timer[@]}"} bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$probe" "$port" 2>/dev/null; then
    printf '%s\n' "$probe"
  fi
}

listener_conflicts() {
  local listener=${1%%%*} bind=$2
  listener=${listener#[}
  listener=${listener%]}
  case $bind in 0.0.0.0 | :: | '') return 0 ;; esac
  case $listener in 0.0.0.0 | '*' | :: | "$bind") return 0 ;; esac
  return 1
}

doctor_port() {
  local port bind probe listener conflict="" published
  port=$(env_value AIQSA_PORT)
  port=${port:-3000}
  bind=$(env_value AIQSA_BIND_ADDRESS)
  bind=${bind:-127.0.0.1}
  if [[ ! $port =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    check FAIL port "AIQSA_PORT is not a valid port number"
    return 0
  fi
  probe=$bind
  case $probe in 0.0.0.0 | :: | '') probe=127.0.0.1 ;; esac
  while IFS= read -r listener; do
    if listener_conflicts "$listener" "$bind"; then conflict=$listener; break; fi
  done < <(port_listeners "$port" "$probe")
  if [[ -z $conflict ]]; then
    check PASS port "$bind:$port is free"
    return 0
  fi
  if docker_ready && published=$(dc port app 3000 2>/dev/null) && [[ ${published##*:} == "$port" ]]; then
    check PASS port "$bind:$port is served by this project's app container"
    return 0
  fi
  check FAIL port "$bind:$port is already in use by another process" \
    "Stop that process or choose another port with AIQSA_PORT in .env (and update AIQSA_APP_BASE_URL)."
}

doctor_kvm() {
  local level=INFO
  kvm_probe
  if workspace_expected; then level=FAIL; fi
  if (( ! KVM_OK )); then
    if [[ $level == INFO ]]; then
      # Workspace off: the KVM facts are informational only.
      check INFO kvm "Workspace unavailable: $KVM_REASON (virtualization: $KVM_VIRT)" \
        "Workspace needs KVM; on virtual machines enable nested virtualization or use a bare-metal host."
    elif [[ -f $ENV_FILE ]]; then
      check FAIL kvm "Workspace is enabled but $KVM_REASON (virtualization: $KVM_VIRT)" \
        "Enable nested virtualization or use a bare-metal host."
    else
      check FAIL kvm "AIQSA needs KVM for Workspace, but $KVM_REASON (virtualization: $KVM_VIRT)" \
        "$(kvm_required_help)"
    fi
    return 0
  fi
  check PASS kvm "$KVM_DEVICE usable by group $KVM_GID (virtualization: $KVM_VIRT)"
  local configured
  configured=$(env_value AIQSA_KVM_GID)
  if [[ -f $ENV_FILE ]] && profile_enabled workspace && [[ $configured != "$KVM_GID" ]]; then
    check FAIL kvm-gid "AIQSA_KVM_GID is '${configured:-unset}' but $KVM_DEVICE belongs to group $KVM_GID" \
      "Set AIQSA_KVM_GID=$KVM_GID in .env."
  fi
}

# ---------------------------------------------------------------- doctor: configuration

doctor_config() {
  if [[ ! -f $ENV_FILE ]]; then
    check FAIL configuration "$(display_path "$ENV_FILE") does not exist" "Run ./aiqsa.sh configure or ./aiqsa.sh install."
    return 0
  fi
  local mode owner key missing=() base_url bind port
  mode=$(stat -c %a -- "$ENV_FILE")
  owner=$(stat -c %u -- "$ENV_FILE")
  if [[ $mode != 600 ]]; then
    check WARN env-file "mode $mode; it holds secrets" "chmod 600 $(display_path "$ENV_FILE")"
  elif [[ $owner != "$(id -u)" ]]; then
    check WARN env-file "owned by uid $owner, not the current user" "Run ./aiqsa.sh as the owner of $(display_path "$ENV_FILE")."
  else
    check PASS env-file "mode 600, owned by the current user"
  fi
  if (( ENV_INVALID_LINES )); then
    check WARN env-file "$ENV_INVALID_LINES line(s) are neither comments nor KEY=VALUE"
  fi
  for key in AIQSA_APP_BASE_URL AIQSA_INITIAL_ADMIN_EMAIL "${GENERATED_KEYS[@]}"; do
    [[ -n $(env_value "$key") ]] || missing+=("$key")
  done
  if (( ${#missing[@]} )); then
    check FAIL required-keys "empty or missing: ${missing[*]}" \
      "Set them in $(display_path "$ENV_FILE"); ./aiqsa.sh upgrade --add-missing-keys generates missing secrets."
  else
    check PASS required-keys "all set"
  fi
  base_url=$(env_value AIQSA_APP_BASE_URL)
  bind=$(env_value AIQSA_BIND_ADDRESS)
  bind=${bind:-127.0.0.1}
  port=$(env_value AIQSA_PORT)
  if [[ -n $base_url ]] && ! valid_base_url "$base_url"; then
    check FAIL base-url "AIQSA_APP_BASE_URL must be an http(s) origin without path, query or fragment"
  elif [[ -n $base_url ]]; then
    local host=${base_url#*://} url_port
    host=${host%/}
    url_port=80
    if [[ $host =~ :([0-9]+)$ ]]; then url_port=${BASH_REMATCH[1]}; fi
    if [[ $host == \[* ]]; then host=${host%%]*}]; else host=${host%:*}; fi
    if [[ $base_url == http://* && $host =~ ^(localhost|127\.[0-9.]+|\[::1\])$ && $url_port != "${port:-3000}" ]]; then
      check WARN base-url "$base_url uses port $url_port but the application listens on ${port:-3000}" \
        "Set AIQSA_PORT=$url_port in $(display_path "$ENV_FILE"), or change AIQSA_APP_BASE_URL."
    elif loopback_address "$bind" && [[ $base_url == https://* || ! $host =~ ^(localhost|127\.[0-9.]+|\[::1\])$ ]]; then
      check INFO base-url "$base_url with a loopback bind: a reverse proxy is expected" \
        "Point the proxy at $bind:${port:-3000}, set AIQSA_TRUST_PROXY_HEADERS=1 and AIQSA_TRUSTED_PROXY_COUNT for your proxy chain," \
        "and give it an upstream read timeout above the Memory admission timeout (30 s by default, up to 120 s)."
    elif ! loopback_address "$bind" && [[ $base_url == http://* ]]; then
      check WARN base-url "$base_url is served over plain HTTP on $bind" \
        "Bind to loopback and terminate TLS in a reverse proxy for internet access."
    else
      check PASS base-url "$base_url"
    fi
  fi
  doctor_workspace_block
  doctor_compose_config
}

doctor_workspace_block() {
  local present=() absent=() key
  if profile_enabled workspace; then present+=(COMPOSE_PROFILES=workspace); else absent+=(COMPOSE_PROFILES=workspace); fi
  for key in AIQSA_WORKSPACE_RUNNER_URL AIQSA_WORKSPACE_RUNNER_TOKEN AIQSA_KVM_GID; do
    if [[ -n $(env_value "$key") ]]; then present+=("$key"); else absent+=("$key"); fi
  done
  if (( ${#present[@]} == 4 )); then
    check PASS workspace "enabled"
  elif (( ${#present[@]} == 0 )); then
    (( KVM_OK )) || kvm_probe
    check WARN workspace "disabled: unsupported configuration; Workspace and the features that depend on it are unavailable" \
      "On a host with usable KVM, set all four values together:" "$(workspace_lines | sed 's/^/  /')"
  else
    (( KVM_OK )) || kvm_probe
    check FAIL workspace "incomplete Workspace block; missing: ${absent[*]}" \
      "Set all four values together or none of them:" "$(workspace_lines | sed 's/^/  /')"
  fi
}

doctor_compose_config() {
  local errors services
  command -v docker >/dev/null 2>&1 || return 0
  ensure_temp_dir
  errors=$TEMP_DIR/compose-config.err
  # Never show `config` output: it carries resolved secrets.
  if dc config --quiet >/dev/null 2>"$errors"; then
    check PASS compose-config "valid"
  else
    check FAIL compose-config "docker compose config rejected the configuration: $(tail -n 3 "$errors" | tr '\n' ' ' | mask_stream)"
    return 0
  fi
  if profile_enabled storage-migration; then
    check FAIL legacy-storage "COMPOSE_PROFILES contains storage-migration" \
      "Finish the v0.2.34 runbook, then drop storage-migration from COMPOSE_PROFILES: $LEGACY_RUNBOOK_URL"
  fi
  services=$(dc config --services 2>/dev/null) || services=""
  if grep -qx minio-legacy <<< "$services"; then
    check FAIL legacy-storage "a Compose override defines the minio-legacy service" \
      "Finish the v0.2.34 runbook, then remove minio-legacy and its /legacy mount: $LEGACY_RUNBOOK_URL"
  fi
  if legacy_volume_present; then
    check WARN legacy-storage "the ${PROJECT_NAME}_minio_data volume from the MinIO era still exists" \
      "Keep it until the v0.2.34 migration is verified ($LEGACY_RUNBOOK_URL), then remove it with docker volume rm."
  fi
}

legacy_volume_present() {
  docker_ready || return 1
  load_project_name
  [[ -n $PROJECT_NAME ]] || return 1
  run docker volume inspect "${PROJECT_NAME}_minio_data" >/dev/null 2>&1
}

# ---------------------------------------------------------------- doctor: stack

readonly APP_PROBE='fetch("http://127.0.0.1:3000/api/health/ready").then((r)=>console.log(r.status)).catch(()=>console.log("unreachable"))'
readonly RUNNER_PROBE='fetch("http://127.0.0.1:4310/health",{headers:{authorization:"Bearer "+process.env.AIQSA_WORKSPACE_RUNNER_TOKEN}}).then((r)=>r.json().then((b)=>console.log(r.status+" "+(b.state||"unknown")+" "+(b.reasonCode||"")))).catch(()=>console.log("unreachable"))'

# One line per container: service|state|health|exit code|id. A non-blank
# separator keeps empty fields (Health is empty without a healthcheck).
stack_containers() {
  dc ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}|{{.ID}}' 2>/dev/null
}

app_ready() {
  local status
  status=$(dc exec -T app node -e "$APP_PROBE" </dev/null 2>/dev/null | tail -n 1) || status=unreachable
  APP_STATUS=${status:-unreachable}
  [[ $APP_STATUS == 200 ]]
}

doctor_stack() {
  local required=$1 rows service state health code id restarts runner=0 one_shot
  if ! docker_ready; then
    if (( required )); then check FAIL stack "cannot inspect the stack: Docker is not usable ($DOCKER_STATE)"; fi
    return 0
  fi
  rows=$(stack_containers) || rows=""
  if [[ -z $rows ]]; then
    if (( required )); then
      check FAIL stack "no containers" "Start the stack with ./aiqsa.sh up."
    else
      check INFO stack "no containers yet"
    fi
    return 0
  fi
  while IFS='|' read -r service state health code id; do
    [[ -n $service ]] || continue
    [[ $service == workspace-runner ]] && runner=1
    one_shot=0
    [[ $service == migrate-bootstrap || $service == storage-init ]] && one_shot=1
    if (( one_shot )) && [[ $state == exited ]]; then
      if [[ $code == 0 ]]; then check PASS "$service" "completed"; else
        check FAIL "$service" "exited with code $code" "./aiqsa.sh logs --tail $LOG_TAIL_LINES $service"
      fi
      continue
    fi
    restarts=$(run docker inspect --format '{{.RestartCount}}' "$id" 2>/dev/null) || restarts=0
    if [[ $state != running ]]; then
      check FAIL "$service" "$state${code:+ (exit code $code)}" "./aiqsa.sh logs --tail $LOG_TAIL_LINES $service"
    elif [[ $health == unhealthy ]]; then
      check FAIL "$service" "unhealthy" "./aiqsa.sh logs --tail $LOG_TAIL_LINES $service"
    elif [[ $health == starting ]]; then
      check WARN "$service" "still starting"
    elif [[ $restarts =~ ^[0-9]+$ ]] && (( restarts > 0 )); then
      check WARN "$service" "${health:-running}, restarted $restarts time(s)" "./aiqsa.sh logs --tail $LOG_TAIL_LINES $service"
    else
      check PASS "$service" "${health:-running}"
    fi
  done <<< "$rows"
  if app_ready; then
    check PASS readiness "/api/health/ready answered 200"
  else
    check FAIL readiness "/api/health/ready answered $APP_STATUS" "./aiqsa.sh logs --tail $LOG_TAIL_LINES app"
  fi
  if (( runner )) && profile_enabled workspace; then doctor_runner; fi
  doctor_storage
  doctor_host_probe
  doctor_toolhive_leftovers
  local usage="" entry
  while IFS= read -r entry; do
    [[ -n $entry ]] && usage+="${usage:+; }$entry"
  done < <(run docker system df --format '{{.Type}} {{.Size}} (reclaimable {{.Reclaimable}})' 2>/dev/null || true)
  [[ -z $usage ]] || check INFO docker-disk "$usage"
}

# Releases after v0.2.34 removed the ToolHive runtime; its volume, workload
# containers and generated images are not Compose-managed and stay behind.
doctor_toolhive_leftovers() {
  local lines=() names images
  load_project_name
  if [[ -n $PROJECT_NAME ]]; then
    if [[ -n $(run docker ps -aq --filter "label=com.docker.compose.project=$PROJECT_NAME" \
      --filter label=com.docker.compose.service=toolhive-runtime 2>/dev/null) ]]; then
      lines+=("./aiqsa.sh up   # --remove-orphans removes the toolhive-runtime container")
    fi
    if run docker volume inspect "${PROJECT_NAME}_toolhive_data" >/dev/null 2>&1; then
      lines+=("docker volume rm ${PROJECT_NAME}_toolhive_data")
    fi
  fi
  names=$(run docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^aiqsa-[a-z0-9]{16,24}-[a-z0-9]{24,64}$' | tr '\n' ' ') || names=""
  [[ -z ${names// /} ]] || lines+=("docker rm -f ${names% }")
  images=$(run docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep '^toolhivelocal/' | tr '\n' ' ') || images=""
  [[ -z ${images// /} ]] || lines+=("docker image rm ${images% }")
  (( ${#lines[@]} )) || return 0
  check WARN toolhive-leftovers "local MCP servers were removed; the old ToolHive runtime left Docker state behind" \
    "Once this release works, remove it with:" "${lines[@]/#/  }"
}

doctor_runner() {
  local answer status state reason
  answer=$(dc exec -T workspace-runner node -e "$RUNNER_PROBE" </dev/null 2>/dev/null | tail -n 1) || answer=unreachable
  read -r status state reason <<< "${answer:-unreachable}"
  # Workspace is optional for core readiness, so a runtime that is not ready only warns.
  if [[ $status == 200 && $state == ready ]]; then
    check PASS workspace-runner "runtime ready"
  else
    check WARN workspace-runner "runtime ${state:-$status}${reason:+ ($reason)}; Workspace is unavailable, everything else works" \
      "./aiqsa.sh logs --tail $LOG_TAIL_LINES workspace-runner; check $KVM_DEVICE access and AIQSA_KVM_GID."
  fi
}

doctor_storage() {
  local code=0 endpoint output refused
  ensure_temp_dir
  output=$TEMP_DIR/storage-status.log
  dc run --rm --no-deps -T storage-init status </dev/null >"$output" 2>&1 || code=$?
  endpoint=$(env_value AIQSA_S3_ENDPOINT)
  if (( code == 1 )); then
    # storage-init prints `storage-init: refused <code>`; only network codes prove unreachability.
    refused=$(sed -n 's/^storage-init: refused \([A-Za-z0-9_]*\).*$/\1/p' "$output" | head -n 1)
    case $refused in
      ECONNREFUSED | ENOTFOUND | EAI_AGAIN | ETIMEDOUT | EHOSTUNREACH | ENETUNREACH | ECONNRESET)
        check FAIL storage "object storage is unreachable ($refused)" "./aiqsa.sh logs --tail $LOG_TAIL_LINES seaweedfs" ;;
      *)
        tail -n 20 "$output" | mask_stream | sed 's/^/  /'
        check FAIL storage "storage-init status failed (see the output above)" \
          "docker compose run --rm --no-deps storage-init status" ;;
    esac
    return 0
  fi
  case $code in
    0) check PASS storage "storage marker valid" ;;
    3) if [[ -n $endpoint && $endpoint != http://minio:9000 ]]; then
         check INFO storage "no storage marker on the external endpoint yet"
       else
         check WARN storage "no storage marker yet; storage-init creates it on the first start" "Rerun ./aiqsa.sh up."
       fi ;;
    4) check FAIL storage "the storage marker is invalid or belongs to another installation" \
      "Do not start writers; check AIQSA_S3_* settings and the project name: docker compose run --rm --no-deps storage-init status" ;;
    *) check FAIL storage "storage-init status failed with exit code $code" ;;
  esac
}

doctor_host_probe() {
  command -v curl >/dev/null 2>&1 || return 0
  local port bind status
  port=$(env_value AIQSA_PORT)
  bind=$(env_value AIQSA_BIND_ADDRESS)
  bind=${bind:-127.0.0.1}
  case $bind in 0.0.0.0 | :: | '') bind=127.0.0.1 ;; esac
  loopback_address "$bind" || return 0
  status=$(run curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$bind:${port:-3000}/api/health/ready" 2>/dev/null) || status=unreachable
  if [[ $status == 200 ]]; then
    check PASS host-port "http://$bind:${port:-3000} answers from the host"
  else
    check WARN host-port "http://$bind:${port:-3000} answered ${status:-nothing} from the host" \
      "Check AIQSA_PORT, AIQSA_BIND_ADDRESS and local firewall rules."
  fi
}

doctor_summary() {
  if (( ! QUIET || FAIL_COUNT )); then
    printf 'doctor: %d passed, %d warnings, %d failed\n' "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
  fi
}

# ---------------------------------------------------------------- configure

GENERATED_KEYS=(AIQSA_AUTH_SESSION_SECRET AIQSA_ENCRYPTION_KEY AIQSA_MEMORY_FINGERPRINT_KEYRING
  AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY AIQSA_POSTGRES_PASSWORD AIQSA_S3_SECRET_ACCESS_KEY)

generated_key() {
  case $1 in
    AIQSA_INITIAL_ADMIN_PASSWORD | AIQSA_AUTH_SESSION_SECRET | AIQSA_POSTGRES_PASSWORD | AIQSA_S3_SECRET_ACCESS_KEY \
      | AIQSA_ENCRYPTION_KEY | AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY | AIQSA_MEMORY_FINGERPRINT_KEYRING \
      | AIQSA_WORKSPACE_RUNNER_TOKEN) return 0 ;;
    *) return 1 ;;
  esac
}

# Sets REPLY to a new value for a generated key; fails on bad entropy.
generate_value() {
  local secret
  case $1 in
    AIQSA_ENCRYPTION_KEY | AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY | AIQSA_MEMORY_FINGERPRINT_KEYRING)
      secret=$(openssl rand -base64 32) || return 1
      [[ $secret =~ ^[A-Za-z0-9+/]{43}=$ ]] || return 1 ;;
    *)
      secret=$(openssl rand -hex 32) || return 1
      [[ $secret =~ ^[0-9a-f]{64}$ ]] || return 1 ;;
  esac
  if [[ $1 == AIQSA_MEMORY_FINGERPRINT_KEYRING ]]; then secret="current=v1,v1=$secret"; fi
  REPLY=$secret
}

prompt_value() {
  local name=$1 question=$2 default=$3 validator=$4 answer
  while true; do
    read -r -p "$question${default:+ [$default]}: " answer || return 1
    answer=${answer:-$default}
    if "$validator" "$answer"; then
      printf -v "$name" '%s' "$answer"
      return 0
    fi
    note "Invalid value; try again."
  done
}

can_prompt() { (( ! YES )) && [[ -t 0 ]]; }

template_value() {
  sed -n "s/^$1=//p" "$PROJECT_DIR/.env.example" | head -n 1
}

configure_flags_ignored() {
  if [[ -n ${GIVEN[--workspace]:-} ]]; then
    kvm_probe
    note "Warning: --workspace had no effect because $(display_path "$ENV_FILE") already exists and is never modified." \
      "To enable Workspace by hand, set all four values together:"
    workspace_lines | sed 's/^/  /' >&2
  fi
  if [[ -n ${GIVEN[--base-url]:-}${GIVEN[--admin-email]:-} ]]; then
    note "Warning: --base-url and --admin-email had no effect because $(display_path "$ENV_FILE") already exists."
  fi
}

# Creates the env file from .env.example; never touches an existing one.
configure_create() {
  local line key enable_workspace=0 template="$PROJECT_DIR/.env.example" old_umask
  [[ -f $template && -f $PROJECT_DIR/compose.yaml ]] \
    || die "$EXIT_FAILURE" "Run this command from the AIQSA repository directory."
  command -v openssl >/dev/null 2>&1 || die "$EXIT_FAILURE" "OpenSSL is required to generate installation secrets."
  if [[ -z $BASE_URL ]] && can_prompt; then
    prompt_value BASE_URL "URL users will open" "$(template_value AIQSA_APP_BASE_URL)" valid_base_url
  fi
  if [[ -z $ADMIN_EMAIL ]] && can_prompt; then
    prompt_value ADMIN_EMAIL "Administrator email" "" valid_email
  fi
  if [[ ${WORKSPACE_MODE:-on} == on ]]; then
    kvm_probe
    (( KVM_OK )) || die "$EXIT_PREFLIGHT" "AIQSA needs KVM for Workspace, but $KVM_REASON; no .env was written." "$(kvm_required_help)"
    enable_workspace=1
  fi
  local seen_profiles=0 seen_url=0 seen_token=0 seen_gid=0
  old_umask=$(umask)
  umask 077
  CONFIGURE_TMP=$(mktemp "$(dirname -- "$ENV_FILE")/.env.tmp.XXXXXX")
  while IFS= read -r line || [[ -n $line ]]; do
    key=${line%%=*}
    if [[ $line == "$key=" ]] && generated_key "$key"; then
      generate_value "$key" || die "$EXIT_FAILURE" "OpenSSL failed to generate $key; no .env was written."
      line="$key=$REPLY"
    elif [[ $key == AIQSA_APP_BASE_URL && $line != \#* && -n $BASE_URL ]]; then
      line="AIQSA_APP_BASE_URL=$BASE_URL"
    elif [[ $line == AIQSA_INITIAL_ADMIN_EMAIL= && -n $ADMIN_EMAIL ]]; then
      line="AIQSA_INITIAL_ADMIN_EMAIL=$ADMIN_EMAIL"
    elif (( enable_workspace )); then
      case $line in
        '# COMPOSE_PROFILES=workspace') line=COMPOSE_PROFILES=workspace; seen_profiles=1 ;;
        "# AIQSA_WORKSPACE_RUNNER_URL="*) line=${line#\# }; seen_url=1 ;;
        '# AIQSA_WORKSPACE_RUNNER_TOKEN=')
          generate_value AIQSA_WORKSPACE_RUNNER_TOKEN || die "$EXIT_FAILURE" "OpenSSL failed to generate a runner token; no .env was written."
          line="AIQSA_WORKSPACE_RUNNER_TOKEN=$REPLY"; seen_token=1 ;;
        '# AIQSA_KVM_GID=') line="AIQSA_KVM_GID=$KVM_GID"; seen_gid=1 ;;
      esac
    fi
    printf '%s\n' "$line"
  done < "$template" > "$CONFIGURE_TMP"
  if (( enable_workspace )); then
    {
      (( seen_profiles )) || printf '%s\n' COMPOSE_PROFILES=workspace
      (( seen_url )) || printf '%s\n' "AIQSA_WORKSPACE_RUNNER_URL=$RUNNER_URL_DEFAULT"
      if (( ! seen_token )); then
        generate_value AIQSA_WORKSPACE_RUNNER_TOKEN || die "$EXIT_FAILURE" "OpenSSL failed to generate a runner token; no .env was written."
        printf '%s\n' "AIQSA_WORKSPACE_RUNNER_TOKEN=$REPLY"
      fi
      (( seen_gid )) || printf '%s\n' "AIQSA_KVM_GID=$KVM_GID"
    } >> "$CONFIGURE_TMP"
  fi
  # Hard-link publication is atomic and never replaces an existing file or symlink.
  ln -- "$CONFIGURE_TMP" "$ENV_FILE" || die "$EXIT_FAILURE" "$(display_path "$ENV_FILE") appeared meanwhile; it was preserved."
  rm -f -- "$CONFIGURE_TMP"
  CONFIGURE_TMP=""
  umask "$old_umask"
  say "$(display_path "$ENV_FILE") created with private permissions and unique secrets."
  if (( enable_workspace )); then
    say "Workspace enabled (KVM group $KVM_GID)."
  else
    note "Workspace left off (--workspace off): an unsupported configuration, only for disposable test installations."
  fi
}

configure_next_steps() {
  if [[ -z $ADMIN_EMAIL ]]; then
    say "Set AIQSA_INITIAL_ADMIN_EMAIL and AIQSA_APP_BASE_URL in $(display_path "$ENV_FILE"), then run ./aiqsa.sh up."
  else
    say "Start the stack with ./aiqsa.sh up."
  fi
}

cmd_configure() {
  require_linux
  if [[ -e $ENV_FILE || -L $ENV_FILE ]]; then
    configure_flags_ignored
    die "$EXIT_FAILURE" "$(display_path "$ENV_FILE") already exists; its configuration and secrets were preserved."
  fi
  configure_create
  configure_next_steps
}

# ---------------------------------------------------------------- up

print_stack_table() {
  local rows=$1 service state health code
  note "Current state (docker compose ps):"
  while IFS='|' read -r service state health code _; do
    [[ -n $service ]] || continue
    printf '  %-26s %-10s %-10s exit %s\n' "$service" "$state" "${health:--}" "${code:-0}"
  done <<< "$rows" | mask_stream >&2
}

# Rank of a ps row as the cause of a failed start; lower is more likely, 0 is no candidate.
# Compose lists rows by container name, so the rank, not the order, decides.
service_rank() {
  local service=$1 state=$2 health=$3 code=$4
  if [[ $service == migrate-bootstrap && $state == exited && $code != 0 ]]; then printf 1; return; fi
  if [[ ( $state == exited && $code != 0 ) || $state == restarting || $state == dead || $health == unhealthy ]]; then
    printf 2; return
  fi
  if [[ $health == starting ]] || [[ $state == running && ( $service == migrate-bootstrap || $service == storage-init ) ]]; then
    printf 3; return
  fi
  if [[ $state == created ]]; then printf 4; return; fi
  printf 0
}

failing_service() {
  local rows=$1 service state health code rank best=0 chosen=""
  while IFS='|' read -r service state health code _; do
    [[ -n $service ]] || continue
    rank=$(service_rank "$service" "$state" "$health" "$code")
    if (( rank && ( best == 0 || rank < best ) )); then best=$rank chosen=$service; fi
  done <<< "$rows"
  printf '%s' "$chosen"
}

report_stack_failure() {
  local compose_output=$1 rows service logs
  rows=$(stack_containers) || rows=""
  [[ -z $rows ]] || print_stack_table "$rows"
  service=$(failing_service "$rows")
  if [[ -n $service ]]; then
    note "Last $LOG_TAIL_LINES log lines of $service:"
    logs=$(dc logs --no-color --tail "$LOG_TAIL_LINES" "$service" 2>&1 | mask_stream) || true
    printf '%s\n' "$logs" | sed 's/^/  /' >&2
    if [[ $service == migrate-bootstrap && $logs == *local_mcp_removal_acknowledgement_required* ]]; then
      note "This release removes local MCP servers and stops until you acknowledge it." \
        "Review the local MCP removal note in SELF_HOSTING.md, set AIQSA_ACCEPT_LOCAL_MCP_REMOVAL=1 in .env, then rerun ./aiqsa.sh up."
    fi
  elif [[ -s $compose_output ]]; then
    note "Last lines of docker compose up:"
    tail -n 20 "$compose_output" | mask_stream | sed 's/^/  /' >&2
  fi
  note "Nothing was rolled back. Fix the cause and rerun ./aiqsa.sh up; ./aiqsa.sh doctor shows the full state."
}

# compose_up_wait [OPTION...] [-- SERVICE...]: `docker compose up -d --wait`
# within the readiness budget; on failure it diagnoses the stack and exits 5.
compose_up_wait() {
  local options=() output code=0
  while (( $# )) && [[ $1 != -- ]]; do options+=("$1"); shift; done
  if (( $# )); then shift; fi
  ensure_temp_dir
  output=$TEMP_DIR/compose-up.log
  # --wait-timeout bounds only the final wait: Compose first blocks on
  # migrate-bootstrap and dependency health, so the whole command gets the budget.
  local up=(docker compose --project-directory "$PROJECT_DIR" ${COMPOSE_ENV_ARGS[@]+"${COMPOSE_ENV_ARGS[@]}"}
    up -d ${options[@]+"${options[@]}"} --wait --wait-timeout "$TIMEOUT" "$@")
  if command -v timeout >/dev/null 2>&1; then up=(timeout -k 20 "$TIMEOUT" "${up[@]}"); fi
  if (( QUIET )); then
    run "${up[@]}" >"$output" 2>&1 || code=$?
  else
    run "${up[@]}" 2>&1 | mask_stream | tee "$output" >&2 || code=${PIPESTATUS[0]}
  fi
  (( code != 0 )) || return 0
  if (( code == 124 )); then
    note "docker compose up did not finish within ${TIMEOUT} s; services that were already created keep starting."
  fi
  note "The stack did not become ready (docker compose up failed or the wait timed out)."
  report_stack_failure "$output"
  exit "$EXIT_NOT_READY"
}

# up_stack SECTIONS: SECTIONS is "host+config", "config" or "none".
up_stack() {
  local sections=$1
  [[ -f $ENV_FILE ]] || die "$EXIT_FAILURE" "$(display_path "$ENV_FILE") does not exist; run ./aiqsa.sh install or ./aiqsa.sh configure first."
  env_load
  if (( ! SKIP_PREFLIGHT )) && [[ $sections != none ]]; then
    [[ $sections == config ]] || doctor_host
    doctor_config
    if (( FAIL_COUNT )); then
      doctor_summary
      die "$EXIT_PREFLIGHT" "Preflight failed; fix the FAIL lines above (or rerun with --skip-preflight)."
    fi
  fi
  docker_ready || die "$EXIT_PREFLIGHT" "Docker is not usable ($DOCKER_STATE); run ./aiqsa.sh doctor."
  say "Starting the stack; waiting up to ${TIMEOUT} s for every service to become ready."
  compose_up_wait --remove-orphans
  if ! app_ready; then
    note "The application readiness check answered $APP_STATUS."
    report_stack_failure "$TEMP_DIR/compose-up.log"
    exit "$EXIT_NOT_READY"
  fi
  if profile_enabled workspace; then
    local saved=$WARN_COUNT
    doctor_runner
    if (( WARN_COUNT > saved )); then note "Workspace is not ready; chat and other features work."; fi
  fi
  say "AIQSA is ready at $(env_value AIQSA_APP_BASE_URL)." \
    "Administrator: $(env_value AIQSA_INITIAL_ADMIN_EMAIL); the initial password is AIQSA_INITIAL_ADMIN_PASSWORD in $(display_path "$ENV_FILE")."
}

cmd_up() {
  require_linux
  up_stack host+config
}

# After a successful start: a FAIL means the stack is not ready (exit 5);
# exit 4 stays reserved for preflight before any container change.
post_start_check() {
  doctor_stack 1
  doctor_summary
  (( FAIL_COUNT == 0 )) && return 0
  die "$EXIT_NOT_READY" "The stack started but the checks above failed; fix the FAIL lines and rerun ./aiqsa.sh doctor."
}

# ---------------------------------------------------------------- doctor command

cmd_doctor() {
  require_linux
  env_load
  if (( ! STACK_ONLY )); then
    doctor_host
    if (( ! HOST_ONLY )); then
      if [[ -f $ENV_FILE ]]; then doctor_config; else check INFO configuration "no $(display_path "$ENV_FILE") yet; run ./aiqsa.sh install"; fi
    fi
  fi
  if (( ! HOST_ONLY )); then
    docker_probe
    doctor_stack "$STACK_ONLY"
  fi
  doctor_summary
  (( FAIL_COUNT == 0 )) || exit "$EXIT_PREFLIGHT"
}

# ---------------------------------------------------------------- install

cmd_install() {
  require_linux
  local existing=0
  [[ -e $ENV_FILE || -L $ENV_FILE ]] && existing=1
  if (( ! existing )) && [[ -z $ADMIN_EMAIL ]] && ! can_prompt; then
    die "$EXIT_USAGE" "install needs --admin-email (and usually --base-url) when it cannot prompt."
  fi
  env_load
  doctor_host
  if (( FAIL_COUNT )) && (( ! SKIP_PREFLIGHT )); then
    doctor_summary
    # --skip-preflight cannot help without KVM: install always enables Workspace.
    if (( ! existing && ! KVM_OK )); then die "$EXIT_PREFLIGHT" "Host preflight failed; fix the FAIL lines above."; fi
    die "$EXIT_PREFLIGHT" "Host preflight failed; fix the FAIL lines above (or rerun with --skip-preflight)."
  fi
  if (( existing )); then
    say "$(display_path "$ENV_FILE") already exists; its configuration and secrets were preserved."
    configure_flags_ignored
  else
    configure_create
  fi
  if (( NO_START )); then
    configure_next_steps
    return 0
  fi
  FAIL_COUNT=0 WARN_COUNT=0 PASS_COUNT=0
  up_stack config
  post_start_check
  local base_url
  base_url=$(env_value AIQSA_APP_BASE_URL)
  say "" "Next steps:" \
    "  1. Open $base_url and sign in as $(env_value AIQSA_INITIAL_ADMIN_EMAIL) with AIQSA_INITIAL_ADMIN_PASSWORD from $(display_path "$ENV_FILE")." \
    "  2. Configure model providers in the Control Center." \
    "  3. Keep $(display_path "$ENV_FILE") with your backups; it holds the keys for encrypted configuration."
  if [[ $base_url == https://* ]] || ! [[ $base_url =~ ^http://(localhost|127\.[0-9.]+|\[::1\])(:[0-9]+)?/?$ ]]; then
    say "  4. Put a TLS reverse proxy in front of the application for $base_url."
  fi
}

# ---------------------------------------------------------------- upgrade

git_in() { run git -C "$PROJECT_DIR" "$@"; }

refuse() { die "$EXIT_REFUSED" "Upgrade refused: $1" "${@:2}"; }

# Refuses with git's own reason when the checkout cannot be used.
git_checkout_guard() {
  local errors reason directory
  ensure_temp_dir
  errors=$TEMP_DIR/git-rev-parse.err
  git_in rev-parse --is-inside-work-tree >/dev/null 2>"$errors" && return 0
  reason=$(head -n 1 "$errors")
  case ${reason,,} in
    *"dubious ownership"* | *safe.directory*)
      directory=$(printf '%q' "$PROJECT_DIR")
      refuse "git refuses to use $PROJECT_DIR because another user owns it: $reason" \
        "Run ./aiqsa.sh as the owner of the checkout, or trust it with: git config --global --add safe.directory $directory" ;;
    *"not a git repository"*)
      refuse "$PROJECT_DIR is not a git checkout: $reason" "Update it as described in SELF_HOSTING.md." ;;
    *)
      refuse "git cannot read $PROJECT_DIR: ${reason:-git rev-parse failed without an error message}" ;;
  esac
}

readonly OFFICIAL_IMAGE=ghcr.io/insciqq/aiqsa

# image_kind KEY VALUE: sets REPLY to unpinned, digest, custom or the pinned
# version (X.Y.Z or X.Y). Only the official repository's release tags compare.
image_kind() {
  local key=$1 value=$2 repository tag prefix=""
  [[ $key == AIQSA_WORKSPACE_RUNNER_IMAGE ]] && prefix=workspace-runner-
  if [[ -z $value ]]; then REPLY=unpinned; return; fi
  if [[ $value == *@* ]]; then REPLY=digest; return; fi
  repository=$value tag=latest
  if [[ ${value##*/} == *:* ]]; then repository=${value%:*} tag=${value##*:}; fi
  [[ $repository == "$OFFICIAL_IMAGE" ]] || { REPLY=custom; return; }
  if [[ $tag == "${prefix:-latest}" || $tag == "${prefix%-}" ]]; then REPLY=unpinned; return; fi
  tag=${tag#"$prefix"}
  if [[ -n $prefix && $tag == "${value##*:}" ]]; then REPLY=custom; return; fi
  if [[ $tag =~ ^[0-9]+\.[0-9]+(\.[0-9]+(-[0-9A-Za-z.-]+)?)?$ ]]; then REPLY=$tag; else REPLY=custom; fi
}

# image_line KEY VERSION: the .env line that pins KEY to the release VERSION.
image_line() {
  if [[ $1 == AIQSA_WORKSPACE_RUNNER_IMAGE ]]; then
    printf '%s=%s:workspace-runner-%s' "$1" "$OFFICIAL_IMAGE" "$2"
  else
    printf '%s=%s:%s' "$1" "$OFFICIAL_IMAGE" "$2"
  fi
}

# Newest stable release tag (vX.Y.Z) in the checkout, without the v.
newest_release() {
  local tag newest=""
  while IFS= read -r tag; do
    [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    if [[ -z $newest ]] || ! version_ge "$newest" "${tag#v}"; then newest=${tag#v}; fi
  done < <(git_in tag --list 'v[0-9]*' 2>/dev/null)
  printf '%s' "$newest"
}

# Images must match the target release before the checkout moves: a pin to
# another version, or an unpinned image on an older --to release, is refused.
image_guard() {
  local target=$1 key value kind keys=(AIQSA_IMAGE) stale=() unpinned=() lines=() newest from
  if [[ -n $(env_value AIQSA_WORKSPACE_RUNNER_IMAGE) ]] || profile_enabled workspace; then
    keys+=(AIQSA_WORKSPACE_RUNNER_IMAGE)
  fi
  for key in "${keys[@]}"; do
    value=$(env_value "$key")
    image_kind "$key" "$value"
    kind=$REPLY
    from=.env
    [[ -n ${!key+set} ]] && from="the process environment"
    case $kind in
      unpinned) unpinned+=("$key") ;;
      digest | custom)
        check INFO image "$key=$value (from $from) is a digest or a custom image; match it to the release notes of $target yourself" ;;
      *)
        if [[ $kind == "$target" || ( $kind =~ ^[0-9]+\.[0-9]+$ && $target == "$kind".* ) ]]; then continue; fi
        stale+=("$key=$value (from $from)")
        lines+=("$(image_line "$key" "$target")") ;;
    esac
  done
  if (( ${#stale[@]} )); then
    refuse "the image settings pin another release than $target: ${stale[*]}." \
      "Set in $(display_path "$ENV_FILE") (and in the environment, if it sets them):" \
      "${lines[@]/#/  }" \
      "Then rerun the upgrade; nothing was changed."
  fi
  [[ -n $TARGET_TAG && ${#unpinned[@]} -gt 0 ]] || return 0
  # AIQSA_IMAGE decides; the runner follows the same rule when Workspace is on.
  [[ ${unpinned[0]} == AIQSA_IMAGE ]] || return 0
  newest=$(newest_release)
  if [[ -n $newest ]] && ! version_ge "$target" "$newest"; then
    lines=()
    for key in "${unpinned[@]}"; do lines+=("$(image_line "$key" "$target")"); done
    refuse "--to $TARGET_TAG is older than the newest release v$newest, but the images are not pinned." \
      "Unpinned images follow the newest release, so the containers would not match the $target checkout." \
      "Pin the release first by setting in $(display_path "$ENV_FILE"):" \
      "${lines[@]/#/  }" \
      "Then rerun the upgrade; nothing was changed."
  fi
}

legacy_guard() {
  local services
  if profile_enabled storage-migration; then
    refuse "COMPOSE_PROFILES contains storage-migration." \
      "Finish the MinIO migration on v0.2.34 first: $LEGACY_RUNBOOK_URL"
  fi
  services=$(dc config --services 2>/dev/null) || services=""
  if grep -qx minio-legacy <<< "$services"; then
    refuse "a Compose override defines the minio-legacy service." \
      "Finish the MinIO migration on v0.2.34 and remove minio-legacy: $LEGACY_RUNBOOK_URL"
  fi
  if legacy_volume_present; then
    # A completed migration leaves a valid marker; the old volume is then a kept backup.
    if dc run --rm --no-deps -T storage-init status </dev/null >/dev/null 2>&1; then
      note "Note: the ${PROJECT_NAME}_minio_data volume still exists; remove it once the migration is verified."
    else
      refuse "the ${PROJECT_NAME}_minio_data volume exists and no valid storage marker was found." \
        "Installations from v0.2.0-v0.2.30 must stop at v0.2.34 and follow $LEGACY_RUNBOOK_URL" \
        "If the migration is complete, start the stack (./aiqsa.sh up) and rerun the upgrade."
    fi
  fi
}

# Decides before anything changes; the backup itself runs right before the
# checkout moves, after every other refusal.
confirm_backup() {
  (( BACKUP_CONFIRMED || BACKUP_NOW )) && return 0
  if can_prompt; then
    local answer
    read -r -p "Create a backup now with ./aiqsa.sh backup (the stack stops briefly)? [Y/n] " answer || answer=no
    case ${answer,,} in
      '' | y | yes) BACKUP_NOW=1; return 0 ;;
    esac
    read -r -p "Is there a current backup of PostgreSQL, object storage and .env? Type yes to continue: " answer || answer=""
    [[ $answer == yes ]] && return 0
  fi
  refuse "a current backup was not confirmed." \
    "Rerun with --backup to create one first, or with --backup-confirmed when a current backup of PostgreSQL, object storage and .env exists."
}

cmd_upgrade() {
  require_linux
  [[ -f $ENV_FILE ]] || die "$EXIT_FAILURE" "$(display_path "$ENV_FILE") does not exist; use ./aiqsa.sh install for a new installation."
  env_load
  if (( ! SKIP_PREFLIGHT )); then
    doctor_host
    if (( FAIL_COUNT )); then
      doctor_summary
      die "$EXIT_PREFLIGHT" "Host preflight failed; fix the FAIL lines above (or rerun with --skip-preflight)."
    fi
  fi
  command -v git >/dev/null 2>&1 || refuse "git is not installed."
  git_checkout_guard
  local branch="" dirty
  dirty=$(git_in status --porcelain --untracked-files=no) || refuse "git status failed."
  if [[ -n $dirty ]]; then
    refuse "the checkout has local changes to tracked files." \
      "Commit, stash or discard them yourself (git status shows them); the CLI never stashes or resets."
  fi
  branch=$(git_in symbolic-ref --quiet --short HEAD 2>/dev/null) || branch=""
  if [[ -z $branch && -z $TARGET_TAG ]]; then
    refuse "HEAD is detached (the installation is on a release tag)." \
      "Installations on a detached HEAD always pass the release tag: ./aiqsa.sh upgrade --to vX.Y.Z"
  fi
  legacy_guard
  confirm_backup
  say "Fetching releases."
  git_in fetch --tags --quiet || die "$EXIT_FAILURE" "git fetch failed; nothing was changed."
  local target_ref current target previous
  if [[ -n $TARGET_TAG ]]; then
    git_in rev-parse --verify --quiet "refs/tags/$TARGET_TAG^{commit}" >/dev/null \
      || refuse "tag $TARGET_TAG does not exist."
    target_ref="refs/tags/$TARGET_TAG"
  else
    git_in rev-parse --verify --quiet '@{upstream}' >/dev/null 2>&1 \
      || refuse "branch $branch has no upstream." "Pass --to vX.Y.Z or set an upstream with git branch --set-upstream-to."
    target_ref='@{upstream}'
  fi
  current=$(package_version < "$PROJECT_DIR/package.json")
  target=$(git_in show "$target_ref:package.json" 2>/dev/null | package_version) || target=""
  [[ -n $current && -n $target ]] || refuse "the current or target version could not be read from package.json."
  if ! version_ge "$target" "$current"; then
    refuse "the target version $target is older than the current $current; downgrades are not supported."
  fi
  git_in cat-file -e "$target_ref:aiqsa.sh" 2>/dev/null \
    || refuse "the target release has no aiqsa.sh." "Update it by hand as described in SELF_HOSTING.md."
  image_guard "$target"
  if (( BACKUP_NOW )); then
    BACKUP_CONTEXT=upgrade
    backup_create "$(default_backup_dir)"
    BACKUP_CONTEXT=backup
  fi
  say "Upgrading from $current to $target. Release notes: $REPOSITORY_URL/releases/tag/v$target"
  previous=$(git_in rev-parse HEAD)
  if [[ -n $TARGET_TAG ]]; then
    git_in checkout --quiet --detach "$target_ref" || refuse "git checkout $TARGET_TAG failed; nothing was changed."
  else
    git_in pull --ff-only --quiet || refuse "git pull --ff-only failed; nothing was changed." \
      "The branch may have diverged from its upstream; resolve it with git yourself."
  fi
  local args=(__upgrade-apply --previous-ref "$previous" --env-file "$ENV_FILE" --timeout "$TIMEOUT")
  (( YES )) && args+=(--yes)
  (( QUIET )) && args+=(--quiet)
  (( VERBOSE )) && args+=(--verbose)
  (( SKIP_PREFLIGHT )) && args+=(--skip-preflight)
  (( ADD_MISSING_KEYS )) && args+=(--add-missing-keys)
  # exec skips the EXIT trap, so clean up first.
  cleanup
  TEMP_DIR="" CONFIGURE_TMP=""
  exec bash "$PROJECT_DIR/aiqsa.sh" "${args[@]}"
}

# Prints `env KEY` for template keys only the process environment sets (as
# env_value resolves them) and `missing KEY` for keys set nowhere.
missing_template_keys() {
  local line key
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
    key=${BASH_REMATCH[1]}
    [[ -z ${ENV_VALUES[$key]+set} ]] || continue
    if [[ -n ${!key+set} ]]; then printf 'env %s\n' "$key"; else printf 'missing %s\n' "$key"; fi
  done < "$PROJECT_DIR/.env.example"
}

# Appends lines only; the existing bytes of the env file are never rewritten.
append_missing_keys() {
  local block="" key
  for key in "$@"; do
    if generated_key "$key"; then
      generate_value "$key" || die "$EXIT_FAILURE" "OpenSSL failed to generate $key; .env was not changed."
      block+="$key=$REPLY"$'\n'
    else
      block+="$(grep -m 1 "^$key=" "$PROJECT_DIR/.env.example")"$'\n'
    fi
  done
  if [[ -s $ENV_FILE && -n $(tail -c 1 -- "$ENV_FILE") ]]; then block=$'\n'"$block"; fi
  printf '%s' "$block" >> "$ENV_FILE"
}

cmd_upgrade_apply() {
  require_linux
  [[ $PREVIOUS_REF =~ ^[0-9a-f]{7,64}$ ]] || die "$EXIT_USAGE" "__upgrade-apply needs --previous-ref <commit>."
  env_load
  local missing=() provided=() output kind key
  while read -r kind key; do
    if [[ $kind == env ]]; then provided+=("$key"); else missing+=("$key"); fi
  done < <(missing_template_keys)
  if (( ${#provided[@]} )); then
    say "Keys in .env.example provided by the environment, not $(display_path "$ENV_FILE"): ${provided[*]}"
  fi
  if (( ${#missing[@]} )); then
    if (( ADD_MISSING_KEYS )); then
      append_missing_keys "${missing[@]}"
      env_load
      say "Appended to $(display_path "$ENV_FILE"): ${missing[*]}"
    else
      note "Keys in .env.example missing from $(display_path "$ENV_FILE"): ${missing[*]}" \
        "Rerun ./aiqsa.sh upgrade --add-missing-keys to append them, or add them by hand."
    fi
  fi
  docker_ready || die "$EXIT_PREFLIGHT" "Docker is not usable ($DOCKER_STATE); run ./aiqsa.sh doctor."
  say "Pulling images."
  ensure_temp_dir
  output=$TEMP_DIR/compose-pull.log
  if ! dc pull --quiet >"$output" 2>&1; then
    tail -n 20 "$output" | mask_stream | sed 's/^/  /' >&2
    refuse "docker compose pull failed; no container was replaced." \
      "The checkout moved from $PREVIOUS_REF to $(git_in rev-parse HEAD)." \
      "Rerunning ./aiqsa.sh upgrade is safe, or return with: git checkout $PREVIOUS_REF"
  fi
  up_stack config
  post_start_check
  say "Upgrade complete."
}

# ---------------------------------------------------------------- backup

human_size() {
  local bytes=$1
  if (( bytes >= 1000000000 )); then printf '%d.%d GB' "$((bytes / 1000000000))" "$((bytes % 1000000000 / 100000000))"
  elif (( bytes >= 1000000 )); then printf '%d.%d MB' "$((bytes / 1000000))" "$((bytes % 1000000 / 100000))"
  elif (( bytes >= 1000 )); then printf '%d.%d kB' "$((bytes / 1000))" "$((bytes % 1000 / 100))"
  else printf '%d B' "$bytes"
  fi
}

checkout_version() {
  local version
  version=$(package_version < "$PROJECT_DIR/package.json" 2>/dev/null) || version=""
  printf '%s' "${version:-unknown}"
}

default_backup_dir() {
  printf '%s/backups/%s-v%s' "$PROJECT_DIR" "$(date -u +%Y%m%dT%H%M%SZ)" "$(checkout_version)"
}

app_image() {
  local image
  image=$(env_value AIQSA_IMAGE)
  printf '%s' "${image:-$OFFICIAL_IMAGE:latest}"
}

objects_external() {
  local endpoint
  endpoint=$(env_value AIQSA_S3_ENDPOINT)
  [[ -n $endpoint && $endpoint != http://minio:9000 ]]
}

# helper OPTION... IMAGE ARG...: a throwaway root container without network;
# root reads and restores the object store's own file ownership.
helper() { run docker run --rm --network none --user 0:0 "$@"; }

pg_user() { local user; user=$(env_value AIQSA_POSTGRES_USER); printf '%s' "${user:-aiqsa}"; }
pg_db() { local db; db=$(env_value AIQSA_POSTGRES_DB); printf '%s' "${db:-aiqsa}"; }

# pg_tool COMPOSE TOOL ARG...: a PostgreSQL client in the postgres service of
# the dc or rc project; the password stays in the container's environment.
pg_tool() {
  local compose=$1
  shift
  # shellcheck disable=SC2016 # Expands in the container shell.
  "$compose" exec -T postgres sh -c 'PGPASSWORD=$POSTGRES_PASSWORD; export PGPASSWORD; exec "$@"' sh "$@"
}

pg_query() {
  pg_tool dc psql -X -A -t -q -v ON_ERROR_STOP=1 -U "$(pg_user)" -d "$(pg_db)" -c "$1" </dev/null
}

newest_migration() {
  local entry newest=""
  for entry in "$PROJECT_DIR"/prisma/migrations/*/; do
    entry=${entry%/}
    entry=${entry##*/}
    if [[ $entry != '*' && $entry > $newest ]]; then newest=$entry; fi
  done
  printf '%s' "$newest"
}

# Sets REPLY to the applied migration when the schema matches this checkout,
# otherwise to the reason, and fails.
schema_check() {
  local newest row applied pending
  newest=$(newest_migration)
  if [[ -z $newest ]]; then REPLY="this checkout has no migrations in prisma/migrations"; return 1; fi
  ensure_temp_dir
  if ! row=$(pg_query "select coalesce(max(migration_name) filter (where finished_at is not null and rolled_back_at is null), '') || '|' || count(*) filter (where finished_at is null and rolled_back_at is null) from _prisma_migrations" 2>"$TEMP_DIR/psql.err"); then
    REPLY="the applied migrations could not be read: $(head -n 1 "$TEMP_DIR/psql.err" | mask_stream)"
    return 1
  fi
  applied=${row%%|*} pending=${row#*|}
  if [[ $pending != 0 ]]; then REPLY="$pending migration(s) are unfinished or failed"; return 1; fi
  if [[ $applied != "$newest" ]]; then
    REPLY="the database is at migration ${applied:-none}, but the newest migration of this checkout is $newest"
    return 1
  fi
  REPLY=$applied
}

existing_ancestor() {
  local path=$1
  while [[ ! -d $path ]]; do path=$(dirname -- "$path"); done
  printf '%s' "$path"
}

backup_refuse() {
  if [[ $BACKUP_CONTEXT == upgrade ]]; then refuse "the backup could not start: $1" "${@:2}"; fi
  die "$EXIT_PREFLIGHT" "Backup refused: $1" "${@:2}"
}

# After the target directory exists: removes the partial backup, restarts the
# stopped services (exit 5 when they do not become ready) and exits.
backup_fail() {
  printf '%s\n' "Backup failed: $1" "${@:2}" | mask_stream >&2
  backup_discard
  if (( BACKUP_STOPPED )); then
    BACKUP_STOPPED=0
    backup_restart
  fi
  if [[ $BACKUP_CONTEXT == upgrade ]]; then refuse "the backup failed; the checkout and the images were not changed."; fi
  exit "$EXIT_FAILURE"
}

# An unfinished backup never stays behind: without SHA256SUMS it could not be
# restored anyway, and its env file holds the installation secrets.
backup_discard() {
  if [[ -z $BACKUP_DIR ]] || (( BACKUP_COMPLETE )); then return 0; fi
  local file
  for file in env manifest postgres.dump objects.tar.gz SHA256SUMS SHA256SUMS.tmp; do rm -f -- "${BACKUP_DIR:?}/$file"; done
  if (( BACKUP_CREATED_DIR )); then rmdir -- "$BACKUP_DIR" 2>/dev/null || true; fi
  note "The incomplete backup in $(display_path "$BACKUP_DIR") was removed."
  BACKUP_DIR=""
}

# Starts exactly the services that were running before, without recreating
# them, and waits like `up`.
backup_restart() {
  (( ${#RESTART_SERVICES[@]} )) || return 0
  say "Restarting ${RESTART_SERVICES[*]}; waiting up to ${TIMEOUT} s."
  compose_up_wait --no-recreate -- "${RESTART_SERVICES[@]}"
  if [[ " ${RESTART_SERVICES[*]} " == *" app "* ]] && ! app_ready; then
    note "The application readiness check answered $APP_STATUS."
    report_stack_failure ""
    exit "$EXIT_NOT_READY"
  fi
}

# The non-secret Memory key IDs a restore needs: never key material.
manifest_key_ids() {
  local entries=() entry ids="" current="" routing
  IFS=',' read -r -a entries <<< "$(env_value AIQSA_MEMORY_FINGERPRINT_KEYRING)"
  for entry in ${entries[@]+"${entries[@]}"}; do
    entry=${entry//[[:space:]]/}
    if [[ $entry == current=* ]]; then
      current=${entry#current=}
    elif [[ $entry == *=?* && ${entry%%=*} =~ $KEY_ID_PATTERN ]]; then
      ids+="${ids:+,}${entry%%=*}"
    fi
  done
  [[ $current =~ $KEY_ID_PATTERN ]] || current=""
  routing=$(env_value AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY_ID)
  routing=${routing:-v1}
  [[ $routing =~ $KEY_ID_PATTERN ]] || routing=invalid
  printf '%s\n' "memory_fingerprint_key_ids=$ids" "memory_fingerprint_current=$current" \
    "memory_opensearch_routing_key_id=$routing"
}

# backup_manifest DIR MIGRATION OBJECTS IMAGES: plain key=value lines, no secrets.
backup_manifest() {
  local dir=$1 migration=$2 objects=$3 images=$4 file service image seen=" " commit
  commit=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null) || commit=unknown
  {
    printf '%s\n' "format=$BACKUP_FORMAT" "aiqsa_version=$(checkout_version)" "git_commit=${commit:-unknown}" \
      "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" "project=$PROJECT_NAME" "migration=$migration" "objects=$objects"
    for file in env postgres.dump objects.tar.gz; do
      if [[ -f $dir/$file ]]; then printf 'size.%s=%s\n' "$file" "$(stat -c %s -- "$dir/$file")"; fi
    done
    while read -r service image; do
      [[ -n $service && $seen != *" $service "* ]] || continue
      seen+="$service "
      printf 'image.%s=%s\n' "$service" "$image"
    done <<< "$images"
    manifest_key_ids
  } > "$dir/manifest"
}

# backup_create DIR: cold backup of PostgreSQL, the bundled object volume and
# .env into DIR. Refusals (exit 4, or 6 for upgrade) change nothing; a later
# failure restarts the stopped services and removes the partial backup.
backup_create() {
  local dir=$1 started=$SECONDS rows service state postgres="" running=" " writers=() restart=()
  local external=0 size_db size_objects=0 available required volume image images migration old_umask errors log file files
  [[ -f $ENV_FILE ]] || backup_refuse "$(display_path "$ENV_FILE") does not exist; there is no installation to back up."
  [[ -r $ENV_FILE ]] || backup_refuse "$(display_path "$ENV_FILE") is not readable by $(id -un); run ./aiqsa.sh as its owner."
  env_load
  docker_ready || backup_refuse "Docker is not usable ($DOCKER_STATE); run ./aiqsa.sh doctor."
  if [[ -e $dir || -L $dir ]]; then
    [[ -d $dir && ! -L $dir ]] || backup_refuse "$(display_path "$dir") exists and is not a directory."
    [[ -z $(ls -A -- "$dir") ]] || backup_refuse "$(display_path "$dir") is not empty; choose a new --output directory."
  fi
  load_project_name
  [[ $PROJECT_NAME =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
    || backup_refuse "the Compose project name could not be resolved; run ./aiqsa.sh doctor."
  rows=$(stack_containers) || rows=""
  while IFS='|' read -r service state _; do
    [[ -n $service ]] || continue
    if [[ $service == postgres ]]; then postgres=$state; fi
    if [[ $state == running && $running != *" $service "* ]]; then running+="$service "; fi
  done <<< "$rows"
  [[ -n $postgres ]] || backup_refuse "the project $PROJECT_NAME has no postgres container." "Start the installation with ./aiqsa.sh up first."
  [[ $postgres == running ]] || backup_refuse "PostgreSQL is $postgres." "Start the installation with ./aiqsa.sh up first."
  for service in $running; do
    if [[ $BACKUP_KEEP_RUNNING != *" $service "* ]]; then writers+=("$service"); fi
    if [[ $ONE_SHOT_SERVICES != *" $service "* ]]; then restart+=("$service"); fi
  done
  schema_check || backup_refuse "the database schema does not match this checkout: $REPLY." \
    "Bring the installation to this checkout's release first (./aiqsa.sh up), then back up."
  ensure_temp_dir
  errors=$TEMP_DIR/backup.err log=$TEMP_DIR/backup.log
  size_db=$(pg_query "select pg_database_size(current_database())" 2>"$errors") || size_db=""
  [[ $size_db =~ ^[0-9]+$ ]] || backup_refuse "the database size could not be read: $(head -n 1 "$errors" | mask_stream)"
  image=$(app_image)
  volume=${PROJECT_NAME}_seaweedfs_data
  if objects_external; then
    external=1
  else
    run docker volume inspect "$volume" >/dev/null 2>&1 || backup_refuse "the object storage volume $volume does not exist."
    size_objects=$(helper -v "$volume:/data:ro" --entrypoint du "$image" -sk /data 2>"$errors" | cut -f1) || size_objects=""
    [[ $size_objects =~ ^[0-9]+$ ]] || backup_refuse "the size of $volume could not be measured: $(head -n 1 "$errors" | mask_stream)"
  fi
  required=$(( (size_db / 1024 + size_objects) * 12 / 10 ))
  available=$(df -Pk -- "$(existing_ancestor "$dir")" 2>/dev/null | awk 'NR == 2 { print $4 }') || available=""
  [[ $available =~ ^[0-9]+$ ]] || backup_refuse "the free space at $(display_path "$dir") could not be read."
  if (( available < required )); then
    backup_refuse "not enough free space: about $(human_size $((required * 1024))) is needed at $(display_path "$dir"), $(human_size $((available * 1024))) is free." \
      "Free space or choose another --output directory."
  fi
  images=$(dc ps -a --format '{{.Service}} {{.Image}}' 2>/dev/null) || images=""

  old_umask=$(umask)
  umask 077
  if [[ ! -d $dir ]]; then
    mkdir -p -- "$dir" || backup_refuse "$(display_path "$dir") could not be created."
    BACKUP_CREATED_DIR=1
  fi
  chmod 700 -- "$dir"
  BACKUP_DIR=$dir BACKUP_COMPLETE=0
  if (( external )); then
    note "AIQSA_S3_ENDPOINT selects external object storage: this backup holds PostgreSQL and .env only." \
      "Back up the bucket with its provider in the same window; the manifest records objects=external."
  fi
  RESTART_SERVICES=(${restart[@]+"${restart[@]}"})
  BACKUP_STOPPED=1
  if (( ${#writers[@]} )); then
    say "Stopping application writers for a consistent copy: ${writers[*]}."
    dc stop "${writers[@]}" >"$log" 2>&1 || backup_fail "docker compose stop failed: $(tail -n 3 "$log" | tr '\n' ' ')"
  fi
  schema_check || backup_fail "the database schema changed while the writers stopped: $REPLY."
  migration=$REPLY
  say "Dumping PostgreSQL."
  pg_tool dc pg_dump -Fc -U "$(pg_user)" -d "$(pg_db)" </dev/null >"$dir/postgres.dump" 2>"$errors" \
    || backup_fail "pg_dump failed: $(tail -n 3 "$errors" | tr '\n' ' ')"
  if (( ! external )); then
    say "Stopping object storage and archiving $volume."
    dc stop minio seaweedfs >"$log" 2>&1 || backup_fail "docker compose stop failed: $(tail -n 3 "$log" | tr '\n' ' ')"
    helper -v "$volume:/data:ro" --entrypoint tar "$image" --numeric-owner -czf - -C /data . >"$dir/objects.tar.gz" 2>"$errors" \
      || backup_fail "archiving $volume failed: $(tail -n 3 "$errors" | tr '\n' ' ')"
  fi
  cp -- "$ENV_FILE" "$dir/env" || backup_fail "copying $(display_path "$ENV_FILE") failed."
  if (( external )); then file=external; else file=bundled; fi
  backup_manifest "$dir" "$migration" "$file" "$images"
  say "Checking the copies."
  dc exec -T postgres pg_restore --list <"$dir/postgres.dump" >/dev/null 2>"$errors" \
    || backup_fail "the dump is not readable (pg_restore --list): $(tail -n 3 "$errors" | tr '\n' ' ')"
  files=(env manifest postgres.dump)
  if (( ! external )); then
    helper -i --entrypoint tar "$image" -tzf - <"$dir/objects.tar.gz" >/dev/null 2>"$errors" \
      || backup_fail "the object archive is not readable (tar -tzf): $(tail -n 3 "$errors" | tr '\n' ' ')"
    files+=(objects.tar.gz)
  fi
  if ! (cd -- "$dir" && sha256sum -- "${files[@]}") >"$dir/SHA256SUMS.tmp" || ! mv -- "$dir/SHA256SUMS.tmp" "$dir/SHA256SUMS"; then
    backup_fail "writing SHA256SUMS failed."
  fi
  for file in "${files[@]}" SHA256SUMS; do chmod 600 -- "$dir/$file"; done
  BACKUP_COMPLETE=1
  BACKUP_STOPPED=0
  backup_restart
  umask "$old_umask"
  say "" "Backup written in $((SECONDS - started)) s to $(display_path "$dir"):"
  for file in "${files[@]}" SHA256SUMS; do say "$(printf '  %-15s %s' "$file" "$(human_size "$(stat -c %s -- "$dir/$file")")")"; done
  if (( external )); then say "Objects: external. Back up the bucket with its provider for the same point in time."; fi
  say "The file env is a copy of .env and holds this installation's secrets: keep the backup private." \
    "Copy the backup to another host or medium; a copy on this disk does not survive the loss of the host."
}

cmd_backup() {
  require_linux
  backup_create "${OUTPUT_DIR:-$(default_backup_dir)}"
}

# ---------------------------------------------------------------- restore

manifest_get() {
  local line
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ ${line%%=*} == "$1" ]]; then printf '%s' "${line#*=}"; return 0; fi
  done < "$2"
}

restore_refuse() { die "$EXIT_PREFLIGHT" "Restore refused: $1" "${@:2}"; }

# Checksums, format, version and object mode; sets REPLY to the version.
restore_verify() {
  local dir=$1 line listed=" " file version current objects
  local pattern='^[0-9a-f]{64} [ *](env|manifest|postgres\.dump|objects\.tar\.gz)$'
  [[ -d $dir ]] || restore_refuse "$(display_path "$dir") is not a directory."
  [[ -f $dir/SHA256SUMS && -f $dir/manifest ]] \
    || restore_refuse "$(display_path "$dir") is not an AIQSA backup: SHA256SUMS or manifest is missing."
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ $pattern ]] || restore_refuse "SHA256SUMS contains an unexpected line."
    listed+="${BASH_REMATCH[1]} "
  done < "$dir/SHA256SUMS"
  for file in env manifest postgres.dump; do
    [[ $listed == *" $file "* ]] || restore_refuse "SHA256SUMS does not cover $file."
  done
  for file in $listed; do
    [[ -f $dir/$file && ! -L $dir/$file ]] || restore_refuse "$file is missing from the backup."
  done
  ensure_temp_dir
  if ! (cd -- "$dir" && sha256sum --quiet --strict -c SHA256SUMS) >"$TEMP_DIR/sha256sum.log" 2>&1; then
    restore_refuse "the backup files do not match SHA256SUMS:" "$(head -n 5 "$TEMP_DIR/sha256sum.log")"
  fi
  [[ $(manifest_get format "$dir/manifest") == "$BACKUP_FORMAT" ]] \
    || restore_refuse "the backup format '$(manifest_get format "$dir/manifest")' is unknown to this release."
  version=$(manifest_get aiqsa_version "$dir/manifest")
  current=$(checkout_version)
  if [[ $version != "$current" ]]; then
    restore_refuse "the backup is from AIQSA $version, but this checkout is $current." \
      "Restore into a checkout of the same release, then upgrade: git checkout v$version"
  fi
  objects=$(manifest_get objects "$dir/manifest")
  case $objects in
    bundled) [[ $listed == *" objects.tar.gz "* ]] || restore_refuse "SHA256SUMS does not cover objects.tar.gz." ;;
    external)
      restore_refuse "this backup uses external object storage (objects=external)." \
        "Its deletion reconciliation needs the bucket inside the isolated restore project, which the CLI cannot provide;" \
        "restore it by hand as described in SELF_HOSTING.md." ;;
    *) restore_refuse "the manifest has an unknown object mode '$objects'." ;;
  esac
  REPLY=$version
}

# The target project must have no container and no volume at all.
restore_target_empty() {
  local found="" name
  found=$(run docker ps -aq --filter "label=com.docker.compose.project=$PROJECT_NAME" 2>/dev/null) \
    || restore_refuse "the containers of $PROJECT_NAME could not be listed."
  if [[ -n $found ]]; then
    restore_refuse "the Compose project $PROJECT_NAME already has containers; restore only fills an empty installation." \
      "Remove that installation first, or set another COMPOSE_PROJECT_NAME in the backup's environment."
  fi
  found=$(run docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT_NAME" 2>/dev/null) \
    || restore_refuse "the volumes of $PROJECT_NAME could not be listed."
  for name in postgres18_data seaweedfs_data opensearch_data storage_socket workspace_runtime_data; do
    if run docker volume inspect "${PROJECT_NAME}_$name" >/dev/null 2>&1; then found+=" ${PROJECT_NAME}_$name"; fi
  done
  if [[ -n ${found//[[:space:]]/} ]]; then
    restore_refuse "volumes of the Compose project $PROJECT_NAME already exist: $(printf '%s' "$found" | tr '\n' ' ')" \
      "Restore only fills an empty installation; remove that installation first."
  fi
}

# AIQSA_KVM_GID is host-specific, neither a secret nor an identity: when
# Workspace is enabled and this host's usable KVM device belongs to another
# group, the new .env gets the host's group. Sets RESTORE_KVM_GID.
restore_kvm_gid() {
  local configured=${ENV_VALUES[AIQSA_KVM_GID]:-}
  RESTORE_KVM_GID=""
  profile_enabled workspace || return 0
  [[ -z ${AIQSA_KVM_GID+set} ]] || return 0
  kvm_probe
  if (( KVM_OK )) && [[ $configured != "$KVM_GID" ]]; then
    RESTORE_KVM_GID=$KVM_GID RESTORE_KVM_GID_FROM=$configured
    ENV_VALUES[AIQSA_KVM_GID]=$KVM_GID
  fi
}

# Hard-link publication is atomic and never replaces an existing file. Only
# the AIQSA_KVM_GID line of this new file may differ from the backup.
restore_publish_env() {
  local source=$1 old_umask line
  old_umask=$(umask)
  umask 077
  CONFIGURE_TMP=$(mktemp "$(dirname -- "$ENV_FILE")/.env.tmp.XXXXXX")
  if [[ -z $RESTORE_KVM_GID ]]; then
    cat -- "$source" > "$CONFIGURE_TMP"
  else
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?AIQSA_KVM_GID[[:space:]]*= ]]; then line="AIQSA_KVM_GID=$RESTORE_KVM_GID"; fi
      printf '%s\n' "$line"
    done < "$source" > "$CONFIGURE_TMP"
  fi
  ln -- "$CONFIGURE_TMP" "$ENV_FILE" || die "$EXIT_FAILURE" "$(display_path "$ENV_FILE") appeared meanwhile; it was preserved and nothing was restored."
  rm -f -- "$CONFIGURE_TMP"
  CONFIGURE_TMP=""
  umask "$old_umask"
}

rc() { run docker compose "${RC_ARGS[@]}" "$@"; }

# Every network internal, no published ports (compose.yaml publishes only the
# app, which never starts here) and the real project's data volumes as external.
restore_override() {
  local network volume
  {
    printf '%s\n' "# Generated by aiqsa.sh restore for $RESTORE_PROJECT." "networks:" "  default:" "    internal: true"
    while IFS= read -r network; do
      printf '  %s:\n    internal: true\n' "$network"
    done < <(awk '/^networks:/ { inside = 1; next } /^[^ #]/ { inside = 0 } inside && /^  [A-Za-z0-9_.-]+:/ { sub(/^  /, ""); sub(/:.*/, ""); print }' "$PROJECT_DIR/compose.yaml")
    printf '%s\n' "volumes:"
    for volume in postgres18_data seaweedfs_data; do
      printf '  %s:\n    external: true\n    name: %s_%s\n' "$volume" "$PROJECT_NAME" "$volume"
    done
  } > "$RESTORE_OVERRIDE"
}

restore_step_failed() {
  die "$EXIT_FAILURE" "Restore failed: $1." "$(tail -n 20 "$2" | sed 's/^/  /')"
}

# Removes the isolated project; its data volumes are external and stay.
restore_project_remove() {
  local volumes=()
  ensure_temp_dir
  if ! rc down >"$TEMP_DIR/restore-down.log" 2>&1; then
    note "docker compose down of $RESTORE_PROJECT failed:"
    tail -n 5 "$TEMP_DIR/restore-down.log" | mask_stream | sed 's/^/  /' >&2
  fi
  mapfile -t volumes < <(run docker volume ls -q --filter "label=com.docker.compose.project=$RESTORE_PROJECT" 2>/dev/null)
  if (( ${#volumes[@]} )) && ! run docker volume rm "${volumes[@]}" >/dev/null 2>&1; then
    note "Remove the leftover volumes of $RESTORE_PROJECT by hand: docker volume rm ${volumes[*]}"
  fi
  RESTORE_PROJECT=""
}

restore_abort() {
  local compose=docker\ compose
  if [[ -n $RESTORE_PROJECT ]]; then restore_project_remove; fi
  if (( ${#COMPOSE_ENV_ARGS[@]} )); then compose+=" --env-file $(printf '%q' "$ENV_FILE")"; fi
  note "" "Nothing of the project $PROJECT_NAME was started. Its restored volumes and $(display_path "$ENV_FILE") are kept for inspection." \
    "To discard this attempt and restore again, run in $PROJECT_DIR:" \
    "  $compose down -v" "  rm $(printf '%q' "$(display_path "$ENV_FILE")")"
}

cmd_restore() {
  require_linux
  local dir=$RESTORE_DIR version target=$ENV_FILE saved=() log script code
  restore_verify "$dir"
  version=$REPLY
  if [[ -e $ENV_FILE || -L $ENV_FILE ]]; then
    restore_refuse "$(display_path "$ENV_FILE") exists; restore only fills an empty installation." \
      "Use a fresh checkout of v$version."
  fi
  [[ -r $dir/env ]] || restore_refuse "$(display_path "$dir/env") is not readable by $(id -un)."
  # The backup's environment drives masking, the project name and the preflight.
  ENV_FILE=$dir/env
  env_load
  docker_ready || restore_refuse "Docker is not usable ($DOCKER_STATE); run ./aiqsa.sh doctor."
  saved=(${COMPOSE_ENV_ARGS[@]+"${COMPOSE_ENV_ARGS[@]}"})
  COMPOSE_ENV_ARGS=(--env-file "$dir/env")
  load_project_name
  COMPOSE_ENV_ARGS=(${saved[@]+"${saved[@]}"})
  [[ $PROJECT_NAME =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
    || restore_refuse "the Compose project name could not be resolved from the backup's environment."
  restore_target_empty
  restore_kvm_gid
  if (( ! SKIP_PREFLIGHT )); then
    doctor_host
    if (( FAIL_COUNT )); then
      doctor_summary
      restore_refuse "host preflight failed; fix the FAIL lines above (or rerun with --skip-preflight)."
    fi
  fi
  ENV_FILE=$target
  ensure_temp_dir
  log=$TEMP_DIR/restore.log
  say "Restoring AIQSA $version from $(display_path "$dir") into the Compose project $PROJECT_NAME."
  restore_publish_env "$dir/env"
  RESTORE_PHASE=isolated
  if [[ -n $RESTORE_KVM_GID ]]; then
    note "AIQSA_KVM_GID changed from '$RESTORE_KVM_GID_FROM' to $RESTORE_KVM_GID in $(display_path "$ENV_FILE"): the group of $KVM_DEVICE on this host."
  fi
  env_load
  say "Creating the volumes and containers of $PROJECT_NAME without starting them."
  dc create postgres seaweedfs >"$log" 2>&1 || restore_step_failed "docker compose create postgres seaweedfs failed" "$log"
  say "Unpacking the objects into ${PROJECT_NAME}_seaweedfs_data."
  helper -i -v "${PROJECT_NAME}_seaweedfs_data:/data" --entrypoint tar "$(app_image)" --numeric-owner -xzf - -C /data \
    <"$dir/objects.tar.gz" >"$log" 2>&1 || restore_step_failed "unpacking objects.tar.gz failed" "$log"

  RESTORE_PROJECT=aiqsa-restore-$(date -u +%Y%m%d%H%M%S)
  RESTORE_OVERRIDE=$TEMP_DIR/restore-override.yaml
  restore_override
  RC_ARGS=(--project-directory "$PROJECT_DIR" -p "$RESTORE_PROJECT" -f "$PROJECT_DIR/compose.yaml" -f "$RESTORE_OVERRIDE")
  if [[ -n $RESTORE_OVERRIDE_HOOK ]]; then RC_ARGS+=(-f "$RESTORE_OVERRIDE_HOOK"); fi
  RC_ARGS+=(${COMPOSE_ENV_ARGS[@]+"${COMPOSE_ENV_ARGS[@]}"})
  say "Starting the isolated project $RESTORE_PROJECT: postgres, seaweedfs and minio on internal networks, no published ports."
  local up=(docker compose "${RC_ARGS[@]}" up -d --wait --wait-timeout "$TIMEOUT" postgres seaweedfs minio)
  if command -v timeout >/dev/null 2>&1; then up=(timeout -k 20 "$TIMEOUT" "${up[@]}"); fi
  run "${up[@]}" >"$log" 2>&1 || restore_step_failed "the isolated project did not become ready" "$log"
  say "Restoring PostgreSQL."
  pg_tool rc pg_restore --no-owner --exit-on-error -U "$(pg_user)" -d "$(pg_db)" <"$dir/postgres.dump" >"$log" 2>&1 \
    || restore_step_failed "pg_restore failed" "$log"
  for script in memory:restore:reconcile knowledge:restore:reconcile; do
    say "Reconciling: $script."
    if ! rc run --rm --no-deps -T -e AIQSA_RESTORE_RECONCILIATION=YES -e AIQSA_RESTORE_NETWORK_ISOLATED=YES \
      -e AIQSA_RESTORE_POSTGRES_SERVICE=postgres -e AIQSA_RESTORE_MINIO_SERVICE=minio \
      --entrypoint npm memory-worker run "$script" </dev/null >"$log" 2>&1; then
      code=$(sed -n 's/.*"code":"\([A-Za-z0-9_]*\)".*/\1/p' "$log" | tail -n 1)
      restore_step_failed "$script failed with ${code:-an unknown code}; deletion duties remain, so the restore is not promoted" "$log"
    fi
  done
  say "Removing the isolated project $RESTORE_PROJECT."
  restore_project_remove
  RESTORE_PHASE=started
  FAIL_COUNT=0 WARN_COUNT=0 PASS_COUNT=0
  up_stack none
  # The reconciliation reset both search projections to pending; the running
  # search workers recreate the indexes and project everything from PostgreSQL.
  say "Memory and Knowledge search indexes are being rebuilt from PostgreSQL by the search workers."
  post_start_check
  say "Restore complete."
}

# ---------------------------------------------------------------- logs

# logs_filter LEVELS: keeps only AIQSA JSON lines whose level matches LEVELS
# (for example error|fatal) and drops every other line, plain text included.
# Compose prefixes each line with "<container>  | ".
logs_filter() {
  local pattern="^($1)\$" line payload level
  while IFS= read -r line || [[ -n $line ]]; do
    payload=${line#* | }
    [[ $payload =~ ^[[:space:]]*\{ ]] || continue
    level=${payload#*\"level\":}
    [[ $level != "$payload" ]] || continue
    level=${level#"${level%%[![:space:]]*}"}
    [[ $level == \"* ]] || continue
    level=${level#\"}
    level=${level%%\"*}
    if [[ $level =~ $pattern ]]; then printf '%s\n' "$line"; fi
  done
}

cmd_logs() {
  local args=(logs --no-color) levels="" errors failed=0
  env_load
  docker_ready || die "$EXIT_FAILURE" "Cannot read logs: Docker is not usable ($DOCKER_STATE)${DOCKER_ERROR:+: $DOCKER_ERROR}."
  if [[ -n $SINCE ]]; then args+=(--since "$SINCE"); fi
  if [[ -n $LOGS_TAIL ]]; then
    args+=(--tail "$LOGS_TAIL")
  elif [[ -z $SINCE ]]; then
    args+=(--tail "$LOGS_DEFAULT_TAIL")
  fi
  if (( LOGS_FOLLOW )); then args+=(--follow); fi
  args+=(${LOG_SERVICES[@]+"${LOG_SERVICES[@]}"})
  if (( LOGS_ERRORS )); then levels="error|fatal"; elif (( LOGS_WARNINGS )); then levels="warn|error|fatal"; fi
  ensure_temp_dir
  errors=$TEMP_DIR/logs.err
  if [[ -n $levels ]]; then
    if (( ! QUIET )); then
      note "Showing AIQSA JSON lines at level ${levels//|/, } only; plain-text lines (PostgreSQL, OpenSearch, Tika, Docling, SeaweedFS) are hidden."
    fi
    dc "${args[@]}" 2>"$errors" | logs_filter "$levels" | mask_stream || failed=1
  else
    dc "${args[@]}" 2>"$errors" | mask_stream || failed=1
  fi
  mask_stream < "$errors" >&2
  (( ! failed )) || die "$EXIT_FAILURE" "docker compose logs failed; ./aiqsa.sh doctor shows the state of the stack."
}

# ---------------------------------------------------------------- health

# Whether a Compose service has a running container.
service_running() {
  local rows
  rows=$(stack_containers) || rows=""
  [[ $'\n'$rows == *$'\n'"$1|running|"* ]]
}

# The read-only telemetry report of scripts/health-report.ts, run in the
# running app container or, when the app is down, in a one-off app container
# without dependencies. Exit 1 and 2 are the report's own (read failure, usage).
cmd_health() {
  local args=(node --import tsx scripts/health-report.ts) errors status=0 where
  env_load
  docker_ready || die "$EXIT_FAILURE" "Cannot read health: Docker is not usable ($DOCKER_STATE)${DOCKER_ERROR:+: $DOCKER_ERROR}."
  if [[ -n $SINCE ]]; then args+=(--since "$SINCE"); fi
  if [[ -n $HEALTH_RUN ]]; then args+=(--run "$HEALTH_RUN"); fi
  if (( HEALTH_FULL )); then args+=(--full); fi
  if [[ -n $HEALTH_USER ]]; then args+=(--user "$HEALTH_USER"); fi
  if (( HEALTH_JSON )); then args+=(--json); fi
  ensure_temp_dir
  errors=$TEMP_DIR/health.err
  if service_running app; then
    where="docker compose exec app"
    dc exec -T app "${args[@]}" </dev/null 2>"$errors" | mask_stream || status=$?
  else
    (( QUIET )) || note "The app container is not running; reading health from a one-off app container."
    where="docker compose run app"
    dc run --rm --no-deps -T app "${args[@]}" </dev/null 2>"$errors" | mask_stream || status=$?
  fi
  mask_stream < "$errors" >&2
  case $status in
    0) ;;
    1 | 2) exit "$status" ;;
    *) die "$EXIT_FAILURE" "$where failed (exit $status); ./aiqsa.sh doctor shows the state of the stack." ;;
  esac
}

# ---------------------------------------------------------------- version and help

cmd_version() {
  local version describe
  version=$(package_version < "$PROJECT_DIR/package.json" 2>/dev/null) || version=""
  describe=$(git -C "$PROJECT_DIR" describe --tags --always --dirty 2>/dev/null) || describe=""
  printf 'AIQSA %s%s\n' "${version:-unknown}" "${describe:+ ($describe)}"
}

cmd_help() {
  cat <<'EOF'
Usage: ./aiqsa.sh <command> [options]

Commands:
  install    Check the host (KVM required), create .env when missing, start the stack, verify it.
  configure  Create .env from .env.example with unique secrets (never overwrites).
  doctor     Read-only checks of the host, .env and the running stack.
  up         Preflight, then start or update containers and wait until ready.
  upgrade    Update the checkout to the next release and restart safely.
  backup     Cold backup of PostgreSQL, bundled object storage and .env (writers stop briefly).
  restore <backup-dir>
             Restore a backup into an empty installation of the same version;
             backups made with external object storage are refused (restore those by hand).
  logs [service...]
             Print the stack's container logs with .env secrets masked
             (default: the last 200 lines per container, all services).
  health     Read-only report of recent problems from the persisted telemetry: what needs
             attention, error totals, failing providers, restarts, stuck queues and the
             latest incidents (works while the app container is down).
  version    Print the checkout version.
  help       Print this help.

Options:
  --yes                  Never prompt; use flags and defaults.
  --env-file <path>      Configuration file (default: .env next to aiqsa.sh).
  --timeout <seconds>    Readiness wait for up/install/upgrade (default 600).
  --quiet, --verbose     Less output, or also print the commands being run.
  --base-url <url>       configure/install: URL users will open (http(s) origin).
  --admin-email <email>  configure/install: initial administrator email.
  --workspace on|off     configure: Workspace needs a usable /dev/kvm and is on by default
                         (install always requires it); off writes an unsupported
                         configuration for disposable test installations only.
  --no-start             install: stop after creating .env.
  --host-only, --stack-only
                         doctor: limit the checks to one section.
  --skip-preflight       up/install/upgrade/restore: continue despite failed preflight checks.
  --to vX.Y.Z            upgrade: move to this release tag instead of the branch upstream
                         (required on a detached HEAD). Images follow the .env image
                         settings, otherwise the newest release.
  --backup               upgrade: create a backup (default location) before the checkout moves.
  --backup-confirmed     upgrade: confirm a current backup without prompting.
  --output <dir>         backup: new or empty target directory
                         (default backups/<UTC time>-v<version> in the checkout).
  --add-missing-keys     upgrade: append keys new in .env.example to .env.
  --errors               logs: keep only AIQSA JSON lines at level error or fatal.
  --warnings             logs: keep only AIQSA JSON lines at level warn, error or fatal.
                         Both filters drop plain-text lines, which includes every line
                         of PostgreSQL, OpenSearch, Tika, Docling and SeaweedFS.
  --since <duration>     logs: only lines newer than a duration (30m, 2h, 1h30m)
                         or an RFC 3339 time (2026-01-31T08:00:00Z); without
                         --tail every line in that window is printed.
  --tail <n|all>         logs: last lines per container (default 200 without --since).
  --follow, -f           logs: keep streaming new lines until interrupted.
  --since 24h|7d|14d|30d health: report range (default 24h).
  --json                 health: machine-readable JSON instead of text.
  --run <reference>      health: look up the runs and incidents of an error reference
                         (the first 8 or more characters of a run id).
  --full                 health: every problem of the range, complete, for an agent on the host.
  --user <id>            health: one user's incidents, failed runs and problem reports.
                         --full and --user print internal user ids and problem-report
                         comments: keep their output on the host, never paste it.

Exit codes: 0 ok, 1 failure, 2 usage, 3 unsupported host, 4 preflight or doctor
check failed (before any container change), 5 stack not ready after a start,
6 upgrade refused (also when its backup fails). A Workspace runner that is not
ready is a warning. A failed backup restarts the stopped services and removes
its partial files; a failed restore starts nothing and prints how to discard it.
EOF
}

# ---------------------------------------------------------------- arguments

usage_error() {
  printf '%s\n' "$1" "Run ./aiqsa.sh help for usage." >&2
  exit "$EXIT_USAGE"
}

display_path() {
  local path=$1
  if [[ $path == "$PROJECT_DIR/"* ]]; then printf '%s' "${path#"$PROJECT_DIR"/}"; else printf '%s' "$path"; fi
}

require_linux() {
  local os
  os=$(uname -s)
  [[ $os == Linux ]] || die "$EXIT_UNSUPPORTED" "Unsupported host: $os. AIQSA's production stack runs on Linux."
}

option_value() {
  [[ $# -ge 2 && -n $2 && $2 != --* ]] || usage_error "$1 needs a value."
}

parse_args() {
  local argument
  while (( $# )); do
    argument=$1
    shift
    case $argument in
      --*=*) set -- "${argument%%=*}" "${argument#*=}" "$@"; continue ;;
    esac
    case $argument in
      -h | --help) HELP=1 ;;
      -y | --yes) YES=1 ;;
      -q | --quiet) QUIET=1 ;;
      -v | --verbose) VERBOSE=1 ;;
      --env-file) option_value "$argument" "$@"; ENV_FILE=$1; shift ;;
      --timeout) option_value "$argument" "$@"; TIMEOUT=$1; shift ;;
      --base-url) option_value "$argument" "$@"; BASE_URL=$1; shift ;;
      --admin-email) option_value "$argument" "$@"; ADMIN_EMAIL=$1; shift ;;
      --workspace) option_value "$argument" "$@"; WORKSPACE_MODE=$1; shift ;;
      --to) option_value "$argument" "$@"; TARGET_TAG=$1; shift ;;
      --previous-ref) option_value "$argument" "$@"; PREVIOUS_REF=$1; shift ;;
      --host-only) HOST_ONLY=1 ;;
      --stack-only) STACK_ONLY=1 ;;
      --no-start) NO_START=1 ;;
      --skip-preflight) SKIP_PREFLIGHT=1 ;;
      --backup) BACKUP_NOW=1 ;;
      --backup-confirmed) BACKUP_CONFIRMED=1 ;;
      --output) option_value "$argument" "$@"; OUTPUT_DIR=$1; shift ;;
      --add-missing-keys) ADD_MISSING_KEYS=1 ;;
      --errors) LOGS_ERRORS=1 ;;
      --warnings) LOGS_WARNINGS=1 ;;
      --since) option_value "$argument" "$@"; SINCE=$1; shift ;;
      --json) HEALTH_JSON=1 ;;
      --run) option_value "$argument" "$@"; HEALTH_RUN=$1; shift ;;
      --full) HEALTH_FULL=1 ;;
      --user) option_value "$argument" "$@"; HEALTH_USER=$1; shift ;;
      --tail) option_value "$argument" "$@"; LOGS_TAIL=$1; shift ;;
      -f | --follow) LOGS_FOLLOW=1 ;;
      -*) usage_error "Unknown option: $argument" ;;
      *)
        if [[ -z $COMMAND ]]; then
          COMMAND=$argument
        elif [[ $COMMAND == restore && -z $RESTORE_DIR ]]; then
          RESTORE_DIR=$argument
        elif [[ $COMMAND == logs ]]; then
          LOG_SERVICES+=("$argument")
        else
          usage_error "Unexpected argument: $argument"
        fi
        continue ;;
    esac
    GIVEN[$argument]=1
  done
}

validate_args() {
  local allowed option
  case $COMMAND in
    install) allowed=" --base-url --admin-email --no-start --skip-preflight " ;;
    configure) allowed=" --base-url --admin-email --workspace " ;;
    doctor) allowed=" --host-only --stack-only " ;;
    up) allowed=" --skip-preflight " ;;
    upgrade) allowed=" --to --backup --backup-confirmed --add-missing-keys --skip-preflight " ;;
    backup) allowed=" --output " ;;
    restore) allowed=" --skip-preflight " ;;
    logs) allowed=" --errors --warnings --since --tail -f --follow " ;;
    health) allowed=" --since --json --run --full --user " ;;
    __upgrade-apply) allowed=" --previous-ref --add-missing-keys --skip-preflight " ;;
    version | help) allowed=" " ;;
    "") usage_error "Missing command." ;;
    *) usage_error "Unknown command: $COMMAND" ;;
  esac
  allowed+="-h --help -y --yes -q --quiet -v --verbose --env-file --timeout "
  for option in "${!GIVEN[@]}"; do
    [[ $allowed == *" $option "* ]] || usage_error "$option is not valid for $COMMAND."
  done
  if (( QUIET && VERBOSE )); then usage_error "--quiet and --verbose are mutually exclusive."; fi
  if (( HOST_ONLY && STACK_ONLY )); then usage_error "--host-only and --stack-only are mutually exclusive."; fi
  if (( BACKUP_NOW && BACKUP_CONFIRMED )); then usage_error "--backup and --backup-confirmed are mutually exclusive."; fi
  if (( LOGS_ERRORS && LOGS_WARNINGS )); then usage_error "--errors and --warnings are mutually exclusive."; fi
  if [[ -n $LOGS_TAIL && ! $LOGS_TAIL =~ ^(all|0|[1-9][0-9]{0,6})$ ]]; then usage_error "--tail must be a line count or all."; fi
  if [[ $COMMAND == health ]]; then
    if [[ -n $SINCE && ! $SINCE =~ ^(24h|7d|14d|30d)$ ]]; then usage_error "--since must be 24h, 7d, 14d or 30d for health."; fi
    if [[ -n $SINCE && -n $HEALTH_RUN ]]; then usage_error "--run and --since are mutually exclusive."; fi
    if [[ -n $HEALTH_RUN ]] && (( HEALTH_FULL )); then usage_error "--run and --full are mutually exclusive."; fi
    if [[ -n $HEALTH_RUN && -n $HEALTH_USER ]]; then usage_error "--run and --user are mutually exclusive."; fi
    if (( HEALTH_FULL )) && [[ -n $HEALTH_USER ]]; then usage_error "--full and --user are mutually exclusive."; fi
    if [[ -n $HEALTH_USER && ! $HEALTH_USER =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]]; then
      usage_error "--user needs an internal user id (letters, digits, _ and -)."
    fi
    if [[ -n $HEALTH_RUN && ! $HEALTH_RUN =~ ^[0-9A-Fa-f][0-9A-Fa-f-]{7,35}$ ]]; then
      usage_error "--run needs an error reference: at least the first 8 characters of a run id."
    fi
  elif [[ -n $SINCE && ! $SINCE =~ ^([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h))+$ \
    && ! $SINCE =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$ ]]; then
    usage_error "--since must be a duration like 30m, 2h or 1h30m, or an RFC 3339 time like 2026-01-31T08:00:00Z."
  fi
  for option in ${LOG_SERVICES[@]+"${LOG_SERVICES[@]}"}; do
    [[ $option =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || usage_error "Not a Compose service name: $option"
  done
  if [[ $COMMAND == restore && -z $RESTORE_DIR ]]; then usage_error "restore needs the backup directory: ./aiqsa.sh restore <backup-dir>"; fi
  [[ $TIMEOUT =~ ^[1-9][0-9]{0,4}$ ]] || usage_error "--timeout must be a number of seconds (1-99999)."
  if [[ -n $BASE_URL ]] && ! valid_base_url "$BASE_URL"; then
    usage_error "--base-url must be an http(s) URL without path, query or fragment, for example https://chat.example.com"
  fi
  if [[ -n $ADMIN_EMAIL ]] && ! valid_email "$ADMIN_EMAIL"; then usage_error "--admin-email is not an email address."; fi
  case $WORKSPACE_MODE in '' | on | off) ;; *) usage_error "--workspace must be on or off." ;; esac
  if [[ -n $TARGET_TAG && ! $TARGET_TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then usage_error "--to must be a release tag like v1.2.3."; fi
}

main() {
  local invocation_dir=$PWD
  parse_args "$@"
  if (( HELP )) || [[ -z $COMMAND ]]; then cmd_help; return 0; fi
  validate_args
  if [[ -z $ENV_FILE ]]; then
    ENV_FILE=$PROJECT_DIR/.env
  else
    [[ $ENV_FILE == /* ]] || ENV_FILE=$invocation_dir/$ENV_FILE
    [[ $ENV_FILE == "$PROJECT_DIR/.env" ]] || COMPOSE_ENV_ARGS=(--env-file "$ENV_FILE")
  fi
  if [[ -n $OUTPUT_DIR && $OUTPUT_DIR != /* ]]; then OUTPUT_DIR=$invocation_dir/$OUTPUT_DIR; fi
  if [[ -n $RESTORE_DIR && $RESTORE_DIR != /* ]]; then RESTORE_DIR=$invocation_dir/$RESTORE_DIR; fi
  if [[ -n $RESTORE_OVERRIDE_HOOK && $RESTORE_OVERRIDE_HOOK != /* ]]; then RESTORE_OVERRIDE_HOOK=$invocation_dir/$RESTORE_OVERRIDE_HOOK; fi
  cd -- "$PROJECT_DIR"
  case $COMMAND in
    install) cmd_install ;;
    configure) cmd_configure ;;
    doctor) cmd_doctor ;;
    up) cmd_up ;;
    upgrade) cmd_upgrade ;;
    __upgrade-apply) cmd_upgrade_apply ;;
    backup) cmd_backup ;;
    restore) cmd_restore ;;
    logs) cmd_logs ;;
    health) cmd_health ;;
    version) cmd_version ;;
    help) cmd_help ;;
  esac
}

main "$@"

#!/bin/sh
# One-time upgrade of AIQSA's bundled object storage from MinIO to SeaweedFS.
#
#   sh scripts/migrate-minio-to-seaweedfs.sh --dry-run   read-only preflight
#   sh scripts/migrate-minio-to-seaweedfs.sh             migrate
#   sh scripts/migrate-minio-to-seaweedfs.sh status      completion marker
#
# Run it from the AIQSA checkout after `git pull --ff-only` and
# `docker compose pull`. It uses only the Docker CLI, honours
# COMPOSE_PROJECT_NAME, COMPOSE_FILE and override files, never runs
# `docker compose down`, and never deletes volumes or images. Every refusal
# prints a stable exit code and the next step.
set -u

MIN_COMPOSE_VERSION=2.29.7
MARGIN_BYTES=1073741824
IMAGE_TAG_REPOSITORY=aiqsa-legacy-minio

mode=migrate
case "${1-}" in
  '') ;;
  --dry-run) mode=dry-run ;;
  status) mode=status ;;
  *) mode=usage ;;
esac
if [ "$mode" = usage ] || [ $# -gt 1 ]; then
  printf '%s\n' 'usage: sh scripts/migrate-minio-to-seaweedfs.sh [--dry-run | status]' >&2
  exit 2
fi

step_number=0
step() {
  step_number=$((step_number + 1))
  printf '%s. %s\n' "$step_number" "$*"
}
note() { printf '   %s\n' "$*"; }
fail() {
  printf 'FAILED (exit %s): %s\n' "$1" "$2"
  if [ -n "${3-}" ]; then printf 'Next step: %s\n' "$3"; fi
  exit "$1"
}

work=$(mktemp -d "${TMPDIR:-/tmp}/aiqsa-storage-migration.XXXXXX") || fail 10 'Cannot create a private temporary directory.'
trap 'rm -rf "$work"' 0
trap 'exit 130' 1 2 3 15

version_at_least() {
  have=${1#v}
  have=${have%%[-+]*}
  need=$2
  for position in 1 2 3; do
    have_part=$(printf '%s' "$have" | cut -d. -f"$position")
    need_part=$(printf '%s' "$need" | cut -d. -f"$position")
    case "$have_part" in '' | *[!0-9]*) have_part=0 ;; esac
    if [ "$have_part" -gt "$need_part" ]; then return 0; fi
    if [ "$have_part" -lt "$need_part" ]; then return 1; fi
  done
  return 0
}

# The image reference of one service with no dependencies, from the effective
# configuration; Compose prints each JSON property on its own line.
service_image() {
  docker compose --profile storage-migration config --format json "$1" 2>/dev/null |
    sed -n 's/^ *"image": "\([^"]*\)",\{0,1\}$/\1/p'
}

# Reads the target marker through storage-init. Container commands never read
# the script's stdin, so the procedure also works when piped. Prints the status lines and
# returns 0 (valid), 3 (absent), 4 (invalid or foreign) or 1 (unreachable).
marker_status() {
  docker compose run --rm --no-deps -T storage-init status </dev/null 2>/dev/null
}

step 'Checking Docker and Docker Compose'
docker version >/dev/null 2>&1 || fail 10 'Docker is not reachable.' 'Run the script as a user that may run docker commands.'
compose_version=$(docker compose version --short 2>/dev/null) || fail 10 'Docker Compose v2 is not available.' "Install Docker Compose $MIN_COMPOSE_VERSION or newer."
version_at_least "$compose_version" "$MIN_COMPOSE_VERSION" ||
  fail 10 "Docker Compose $compose_version is older than $MIN_COMPOSE_VERSION." "Upgrade Docker Compose to $MIN_COMPOSE_VERSION or newer."
note "Docker Compose $compose_version"

step 'Reading the effective Compose configuration'
docker compose config --quiet >/dev/null 2>&1 ||
  fail 11 'docker compose config failed in this directory.' 'Run the script from the AIQSA checkout and fix the error that docker compose config prints.'
tool_image=$(service_image storage-migrate)
legacy_image=$(service_image minio-legacy)
if [ -z "$tool_image" ] || [ -z "$legacy_image" ] || [ "$(printf '%s\n' "$tool_image" | wc -l)" -ne 1 ]; then
  fail 11 'This Compose configuration has no SeaweedFS migration services.' 'Update the checkout with git pull --ff-only, then rerun.'
fi
docker image inspect "$tool_image" >/dev/null 2>&1 ||
  fail 11 "The application image $tool_image is not present." 'Run docker compose pull, then rerun.'

if [ "$mode" = status ]; then
  step 'Reading the storage completion marker'
  if [ -z "$(docker compose ps -q --status running minio 2>/dev/null)" ]; then
    fail 31 'The storage service is not running.' 'Start it with docker compose up -d minio, then rerun status.'
  fi
  marker_status
  result=$?
  case $result in
    0) exit 0 ;;
    3) fail 30 'No completion marker: the storage has not been migrated or initialized.' ;;
    *) fail 31 'The completion marker is invalid, belongs to another installation, or storage is unreachable.' ;;
  esac
fi

step 'Resolving the legacy MinIO data and the new SeaweedFS volume'
legacy_image_id=$(docker image inspect -f '{{.Id}}' "$legacy_image" 2>/dev/null || true)
minio_ids=$(docker compose ps -a -q minio 2>/dev/null || true)
reader_ids=$(docker compose --profile storage-migration ps -a -q minio-legacy 2>/dev/null || true)
{
  printf '{"activeServices":['
  separator=''
  docker compose config --services 2>/dev/null | while IFS= read -r service_name; do
    printf '%s"%s"' "$separator" "$service_name"
    separator=','
  done
  printf '],"legacyImageId":"%s","config":' "$legacy_image_id"
  docker compose --profile storage-migration config --format json 2>/dev/null
  printf ',"minioContainers":'
  if [ -n "$minio_ids" ]; then docker inspect $minio_ids; else printf '[]'; fi
  printf ',"legacyContainers":'
  if [ -n "$reader_ids" ]; then docker inspect $reader_ids; else printf '[]'; fi
  printf '}'
} | docker run --rm -i --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --cap-drop ALL --security-opt no-new-privileges "$tool_image" \
  node --import tsx scripts/storage-migrate.ts plan >"$work/plan" 2>/dev/null

project='' bucket='' legacy_origin='' legacy_type='' legacy_source='' target_type='' target_source=''
old_minio_container='' legacy_container='' s3_services='' plan_error='' plan_detail=''
while IFS= read -r line; do
  key=${line%%=*}
  value=${line#*=}
  case $key in
    project) project=$value ;;
    bucket) bucket=$value ;;
    legacy_origin) legacy_origin=$value ;;
    legacy_type) legacy_type=$value ;;
    legacy_source) legacy_source=$value ;;
    target_type) target_type=$value ;;
    target_source) target_source=$value ;;
    old_minio_container) old_minio_container=$value ;;
    legacy_container) legacy_container=$value ;;
    s3_services) s3_services=$value ;;
    error) plan_error=$value ;;
    detail) plan_detail=$value ;;
  esac
done <"$work/plan"

case $plan_error in
  '') ;;
  storage_profile_active)
    fail 12 'COMPOSE_PROFILES activates the storage-migration profile.' 'Remove storage-migration from COMPOSE_PROFILES (environment and .env), then rerun.' ;;
  storage_endpoint_external)
    fail 13 'The application uses an external S3 endpoint; there is no bundled MinIO data to migrate.' 'No migration is needed. Start with docker compose up -d.' ;;
  storage_legacy_mount_mismatch | storage_minio_data_remapped | storage_target_is_legacy | storage_legacy_ambiguous | storage_legacy_source_missing | storage_legacy_source_unsupported)
    fail 14 "Storage mounts do not match ($plan_error). ${plan_detail}" 'In compose.override.yaml remove any /data mapping from the minio service and map the old MinIO data into minio-legacy (/data) and storage-init (/legacy, read-only), then rerun.' ;;
  *)
    fail 11 "The Compose configuration could not be resolved (${plan_error:-no plan})." 'Run docker compose config to check the configuration, then rerun.' ;;
esac
if [ -z "$project" ] || [ -z "$bucket" ] || [ -z "$legacy_source" ] || [ -z "$target_source" ]; then
  fail 11 'The Compose configuration could not be resolved.' 'Run docker compose config to check the configuration, then rerun.'
fi
case "$legacy_source$target_source" in
  *,*) fail 14 'Storage paths containing commas are not supported.' 'Move the data to a path without commas and adjust compose.override.yaml.' ;;
esac
note "Compose project:           $project"
note "Legacy MinIO data ($legacy_origin): $legacy_type $legacy_source"
note "New SeaweedFS data:        $target_type $target_source"
note 'Record both names: backups must switch from the legacy data to the new volume.'

step 'Checking for a completed migration'
if [ -z "$old_minio_container" ] && [ -n "$(docker compose ps -q --status running minio 2>/dev/null)" ]; then
  marker_status >"$work/status"
  result=$?
  case $result in
    0)
      sed 's/^/   /' "$work/status"
      note 'Already migrated: the storage holds a valid completion marker. Nothing was changed.'
      exit 0 ;;
    3) note 'No completion marker yet.' ;;
    4) fail 19 'The new storage holds an invalid completion marker or one from another installation.' 'Check COMPOSE_PROJECT_NAME and the volumes this checkout uses. Nothing was changed.' ;;
    *) note 'The new storage did not answer; the copier checks the marker again before copying.' ;;
  esac
else
  note 'No completion marker yet.'
fi

step 'Checking the legacy MinIO data'
if [ "$legacy_type" = volume ]; then
  docker volume inspect "$legacy_source" >/dev/null 2>&1 ||
    fail 15 "The legacy volume $legacy_source does not exist." 'Check COMPOSE_PROJECT_NAME and overrides: the old MinIO data must be where Compose expects it. Nothing was changed.'
fi
read_lines() {
  layout='' legacy_bytes='' available='' used=0 inspect_error=''
  while IFS= read -r line; do
    key=${line%%=*}
    value=${line#*=}
    case $key in
      layout) layout=$value ;;
      bytes) legacy_bytes=$value ;;
      available) available=$value ;;
      used) used=$value ;;
      'storage-init: refused '*) inspect_error=${line#storage-init: refused } ;;
    esac
  done <"$1"
}
docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --cap-drop ALL --security-opt no-new-privileges --mount "type=$legacy_type,src=$legacy_source,dst=/legacy,readonly" \
  "$tool_image" node --import tsx scripts/storage-init.ts inspect-legacy /legacy "$bucket" >"$work/legacy" 2>/dev/null
inspection=$?
read_lines "$work/legacy"
if [ "$inspection" -ne 0 ] || [ -z "$layout" ]; then
  fail 15 "The legacy MinIO data could not be read (${inspect_error:-inspection failed})." 'Check that the legacy data is present and readable. Nothing was changed.'
fi
case $layout in
  minio) note "MinIO data found: $legacy_bytes bytes on disk." ;;
  empty) fail 15 "The legacy $legacy_type $legacy_source holds no MinIO data." 'Check COMPOSE_PROJECT_NAME and overrides: the old MinIO data must be where Compose expects it. Nothing was changed.' ;;
  *) fail 15 "The legacy $legacy_type $legacy_source has an unknown layout." 'Nothing was changed. Check what the legacy volume holds before continuing.' ;;
esac
legacy_size=$legacy_bytes

step 'Checking the legacy bucket settings'
if [ -n "$old_minio_container" ] && [ "$(docker inspect -f '{{.State.Running}}' "$old_minio_container" 2>/dev/null)" = true ]; then
  # `docker compose run` would create the new stack's volumes, so a plain
  # container joins the old MinIO's existing network with its own credentials.
  # The secret travels in the environment, never on the command line.
  minio_env() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$old_minio_container" | sed -n "s/^$1=//p"; }
  minio_network=$(docker inspect -f '{{range $name, $value := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$old_minio_container" | sed -n 1p)
  S3_ACCESS_KEY_ID=$(minio_env MINIO_ROOT_USER)
  S3_SECRET_ACCESS_KEY=$(minio_env MINIO_ROOT_PASSWORD)
  export S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
  source_state=$(docker run --rm --network "$minio_network" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    --cap-drop ALL --security-opt no-new-privileges -e S3_ACCESS_KEY_ID -e S3_SECRET_ACCESS_KEY \
    -e S3_ENDPOINT=http://minio:9000 -e "S3_BUCKET=$bucket" "$tool_image" \
    node --import tsx scripts/storage-init.ts check-source 2>/dev/null | sed -n 's/^source=//p')
  unset S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
  case $source_state in
    ok | absent) note "The legacy bucket can be copied ($source_state)." ;;
    storage_migrate_source_*)
      fail 18 "The legacy bucket cannot be copied exactly ($source_state)." 'Versioning, encryption, object lock and public policies are not migrated: restore the default private bucket settings. Nothing was changed.' ;;
    *) fail 18 'The legacy bucket settings could not be read.' 'Check docker compose logs minio, then rerun.' ;;
  esac
else
  note 'MinIO is not running; the copier checks the bucket settings before copying.'
fi

step 'Checking the cached MinIO image'
if [ -z "$legacy_image_id" ]; then
  fail 16 "The MinIO image $legacy_image is not present on this host." "Load it from a host that still has it: docker save '$legacy_image' | ssh <this-host> docker load"
fi
note "Found ${legacy_image%%@*}."

step 'Checking free disk space'
if [ "$target_type" = volume ] && ! docker volume inspect "$target_source" >/dev/null 2>&1; then
  # A new local volume is created below the Docker data root.
  docker_root=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null) || fail 17 'Cannot read the Docker data root.' 'Check docker info, then rerun.'
  space_mount="type=bind,src=$docker_root/volumes,dst=/space,readonly"
  measure=''
else
  space_mount="type=$target_type,src=$target_source,dst=/space,readonly"
  measure=measure
fi
docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --cap-drop ALL --security-opt no-new-privileges --mount "$space_mount" \
  "$tool_image" node --import tsx scripts/storage-init.ts inspect-space /space $measure >"$work/space" 2>/dev/null ||
  fail 17 "Free space for $target_type $target_source could not be measured." 'If the new data is on a bind mount, create that directory, then rerun.'
read_lines "$work/space"
required=$((legacy_size + legacy_size / 10 + MARGIN_BYTES - used))
if [ -z "$available" ] || [ "$available" -lt "$required" ]; then
  fail 17 "Free space ${available:-unknown} bytes is below the required $required bytes (legacy size + 10% + 1 GiB)." 'Free disk space on the Docker data volume, then rerun.'
fi
note "Available $available bytes; required $required bytes."

if [ "$mode" = dry-run ]; then
  step 'Dry run complete: preflight passed and nothing was changed'
  note 'A real run would: tag the MinIO image, stop the stack, start SeaweedFS, apply migrations,'
  note 'start the read-only MinIO reader, copy and verify every object, then start the stack.'
  exit 0
fi

step "Protecting the MinIO image with the local tag $IMAGE_TAG_REPOSITORY:$project"
docker image tag "$legacy_image_id" "$IMAGE_TAG_REPOSITORY:$project" ||
  fail 20 'Could not tag the MinIO image.' 'Rerun the script.'

step 'Stopping the stack (docker compose stop; containers and volumes are kept)'
docker compose stop || fail 20 'docker compose stop failed.' 'Rerun the script.'
# A reader left by an interrupted run is stopped too; its container stays and
# keeps the MinIO image referenced.
docker compose --profile storage-migration stop minio-legacy ||
  fail 20 'Stopping the MinIO reader failed.' 'Rerun the script.'

step 'Checking that no writer or legacy reader is still running'
for container in $(docker ps -q); do
  docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Source}}{{println}}{{end}}' "$container" 2>/dev/null |
    while IFS='|' read -r mount_type mount_name mount_source; do
      if { [ "$legacy_type" = volume ] && [ "$mount_type" = volume ] && [ "$mount_name" = "$legacy_source" ]; } ||
        { [ "$legacy_type" = bind ] && [ "$mount_type" = bind ] && [ "${mount_source%/}" = "$legacy_source" ]; }; then
        printf '%s\n' "$container"
      fi
    done
done >"$work/busy"
if [ -n "$s3_services" ]; then
  # shellcheck disable=SC2086 # service names are validated single words
  docker compose ps -q --status running $s3_services >>"$work/busy" 2>/dev/null
fi
if [ -s "$work/busy" ]; then
  fail 20 "$(wc -l <"$work/busy" | tr -d ' ') running container(s) still use the legacy data or object storage." \
    'Stop them (docker ps shows them), then rerun the script.'
fi

step 'Starting PostgreSQL and the new SeaweedFS storage'
docker compose up -d --wait postgres minio ||
  fail 21 'The new storage did not become healthy.' 'Inspect docker compose logs seaweedfs minio, fix the cause, then rerun.'

step 'Applying database migrations'
docker compose run --rm --no-deps -T migrate-bootstrap </dev/null ||
  fail 22 'Database migrations failed.' 'Inspect the output above, fix the cause, then rerun.'

step 'Starting the read-only MinIO reader'
docker compose --profile storage-migration up -d --wait minio-legacy ||
  fail 23 'The MinIO reader did not become healthy.' 'Inspect docker compose --profile storage-migration logs minio-legacy, then rerun.'

step 'Copying and verifying objects (progress is printed periodically)'
docker compose --profile storage-migration run --rm --no-deps -T storage-migrate copy-from-minio-legacy </dev/null
result=$?
case $result in
  0) ;;
  3)
    # A marker is legitimate only when an earlier run of this script wrote it.
    # If MinIO was still serving at preflight, the operator rolled back and
    # MinIO holds newer data than the SeaweedFS volume.
    if [ -n "$old_minio_container" ]; then
      fail 19 'The new storage already holds a completed migration while MinIO was still in use (a rollback).' \
        "MinIO data is authoritative after a rollback: remove the stale copy with docker volume rm $target_source, then rerun."
    fi
    note 'The completion marker is already present; nothing was copied.' ;;
  *) fail 24 'Copy or verification did not complete; no completion marker was written.' 'Fix the cause named above (for example free disk space), then rerun the script: it resumes.' ;;
esac

step 'Stopping and removing the MinIO reader'
docker compose --profile storage-migration stop minio-legacy >/dev/null 2>&1 &&
  docker compose --profile storage-migration rm -f minio-legacy >/dev/null 2>&1 ||
  note "Warning: remove it later with: docker compose --profile storage-migration rm -sf minio-legacy"

step 'Starting the stack'
docker compose up -d ||
  fail 25 'The stack did not start.' 'Inspect docker compose logs storage-init app, fix the cause, then run docker compose up -d.'
orphans=$(docker ps -a -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=minio-init')
if [ -n "$orphans" ]; then
  note 'An exited minio-init container from the old release remains; remove it with:'
  note "docker rm $(printf '%s' "$orphans" | tr '\n' ' ')"
fi

step 'Migration complete'
note "Legacy MinIO data (kept, remove manually when satisfied): $legacy_type $legacy_source"
note "New SeaweedFS data (back this up from now on):        $target_type $target_source"
note "MinIO image kept as $IMAGE_TAG_REPOSITORY:$project."
note 'Check the result with: sh scripts/migrate-minio-to-seaweedfs.sh status'
exit 0

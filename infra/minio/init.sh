#!/bin/sh
set -eu
until mc alias set local "http://minio:9000" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"; do sleep 2; done
mc mb --ignore-existing "local/$MINIO_BUCKET"
mc anonymous set none "local/$MINIO_BUCKET"
mc ilm rule add "local/$MINIO_BUCKET" --expire-days 1 || true

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../app" && pwd)"

cd "$APP_DIR"
if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${OBJECT_STORAGE_ENDPOINT:?OBJECT_STORAGE_ENDPOINT is required}"
: "${OBJECT_STORAGE_BUCKET:?OBJECT_STORAGE_BUCKET is required}"
: "${OBJECT_STORAGE_ACCESS_KEY:?OBJECT_STORAGE_ACCESS_KEY is required}"
: "${OBJECT_STORAGE_SECRET_KEY:?OBJECT_STORAGE_SECRET_KEY is required}"

docker compose -f docker-compose.prod.yml exec -T api node --input-type=module -e "
import { S3Client, HeadBucketCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
const bucket = process.env.OBJECT_STORAGE_BUCKET;
const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY;
const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_KEY;
const key = 'health/ustal-storage-check-' + Date.now() + '.txt';

const client = new S3Client({
  region: 'ru-1',
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});

await client.send(new HeadBucketCommand({ Bucket: bucket }));
await client.send(new PutObjectCommand({
  Bucket: bucket,
  Key: key,
  Body: 'ustal storage check',
  ContentType: 'text/plain',
}));
await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

console.log('App container verified Timeweb S3 bucket access:', bucket);
"

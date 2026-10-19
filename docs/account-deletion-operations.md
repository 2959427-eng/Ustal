# Account deletion: physical erasure and rollback

Migration0026 fences deleted-user writes. Migration0027 adds durable physical-media cleanup and skips late notifications.

## Physical media cleanup

Account deletion enqueues each provider/key in `media_cleanup_requests` in the same transaction that removes media rows. After commit the API attempts a bounded batch; the worker drains due requests every10seconds. Failed persistence of an uploaded media row also enqueues cleanup before best-effort erasure.

Storage calls run outside SQL transactions. Claims use `SKIP LOCKED`, a two-minute lease and fenced acknowledgements. S3 deletion is bounded to10seconds; a missing object is an idempotent success. Failure backoff starts at one minute and caps at one day. Successful requests are physically removed from the outbox. Provider responses and credentials are never persisted as error text.

The outbox retains private object keys only while needed for erasure. It has no public API. Do not manually delete pending rows to hide failures.

## Production gates

- Verify `s3:DeleteObject` for the existing bucket/prefix before enabling account deletion.
- Inspect pending count and oldest age by provider; repeated failures and provider mismatches require an operational alert.
- Cleanup binds an opaque identity of the S3 endpoint/bucket/region or resolved local directory. Credential rotation does not change it. Another namespace never acknowledges these requests. On storage configuration changes, keep a drainer for the original namespace until its requests are cleared. Local API and worker need the same absolute shared media directory. Unbound requests (no provable namespace) require reconciliation, never blind deletion.
- A crash before an upload key is recorded, or simultaneous DB and storage failure, can still leave an untracked upload. Upload staging/reconciliation is a separate follow-up; this outbox does not claim to solve that failure window.
- Apply migrations after stopping writers and verifying a fresh backup; start the new worker and API together before resuming writers. Do not enable the new deletion route against schema0025.

Read-only diagnostic query:

```sql
SELECT storage_provider, count(*) AS pending, min(created_at) AS oldest,
       count(*) FILTER (WHERE last_error_code IS NOT NULL) AS failed
FROM media_cleanup_requests GROUP BY storage_provider;
```

## Rollback

Account erasure is irreversible; reverting application code never restores deleted data. Preserve the0026 guard and0027 outbox during application rollback. Keep a compatible cleanup worker running until all pending requests are drained; old code does not drain this table. Do not drop either safety mechanism to make an old binary appear healthy. Prefer a verified forward fix; restore a DB backup only through a separately approved recovery plan accounting for writes after that backup.

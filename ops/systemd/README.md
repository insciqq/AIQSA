# Production maintenance timers

Render the three path placeholders in `aiqsa-backup.service.template`, install
the result as `/etc/systemd/system/aiqsa-backup.service`, and install the timer
beside it. Validate before enabling:

```bash
systemd-analyze verify /etc/systemd/system/aiqsa-backup.service /etc/systemd/system/aiqsa-backup.timer
systemctl daemon-reload
systemctl enable --now aiqsa-backup.timer
systemctl list-timers aiqsa-backup.timer
```

The timer runs daily at 03:30 with up to 15 minutes of jitter and catches up
after downtime. The backup script briefly stops the single application writer,
publishes a checksum-verified mode-0700 bundle, and restarts the app only if it
was previously running.

There is deliberately no automatic deletion. Copy verified bundles to
encrypted access-restricted off-host storage, keep at least three known-good
generations, monitor disk space, and remove an old remote bundle only after its
off-host copy passes `ops/backup/restore.sh --verify-only`. Test restore into a
disposable target periodically; never point the restore tool at canonical live
services.

Render the current-directory, environment-file, and operation-lock placeholders
in aiqsa-prune.service.template, then install it with aiqsa-prune.timer. Use the
same shared operation lock as deployment and backup so object deletion, backup
snapshots, and migrations cannot overlap.

~~~bash
systemd-analyze verify /etc/systemd/system/aiqsa-prune.service /etc/systemd/system/aiqsa-prune.timer
systemctl daemon-reload
systemctl enable --now aiqsa-prune.timer
systemctl list-timers aiqsa-prune.timer
~~~

The prune timer runs daily at 04:30 with up to 15 minutes of jitter. It executes
the configured retention policy, including 30-day Knowledge Trash expiry and
cleanup of upload sessions expired for more than seven days, and resumes durable
relational/object deletion obligations. Monitor failed units:
privacy deletion failures remain durable and require repair rather than being
silently discarded.

## Knowledge processing profile rollback

Use this procedure when a newly activated Knowledge processing profile degrades
indexing or retrieval. It changes future processing and future Base snapshots;
accepted runs keep their immutable evidence and existing Sources are not removed.

1. Stop the prune timer and wait for any running prune unit to finish. Do not run
   schema downgrades, delete V2 Sources, or start migration cleanup during the
   rollback window.
2. Create and review a fresh backup with the production backup procedure above.
3. In Control Center, open **Knowledge**. Record the content-free health and
   migration counts, then choose an earlier ready processing profile and select
   **Restore profile**. If the page reports a stale change, reload it and repeat
   against the current version. If the previous destination is unavailable,
   repair or re-enable that configured provider first; the active pointer must
   not be forced with direct SQL.
4. Keep the application and ingestion worker running. They rebuild missing
   artifacts in the background and atomically move each Base from its current
   ready generation to the restored profile only when the replacement generation
   is complete. A provider or parser outage may delay this step but must not make
   core readiness fail.
5. Monitor Control Center until the profile is healthy, `Building bases` is zero,
   and `Bases on active profile` equals `Active bases`. Verify one known citation,
   one exact identifier query, and one ordinary fact query. Old accepted answers
   must still open their original citations.
6. Review a second backup after convergence. Re-enable the prune timer only after
   the counts and sample queries are healthy and no deletion obligations are
   unexpectedly blocked.

Restoring the profile is the supported operational rollback after the V2
read/write cutover. It deliberately does not roll the database schema backward;
the additive schema and all V2 writes remain in place so no user Source is lost.

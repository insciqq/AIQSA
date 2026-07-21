# Production backup timer

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

# Prepare the merged app without changing the live Codespace

The merged app and the old Codespace checkout are different versions. The old checkout may contain unfinished Gemini/YAMM changes and a large live SQLite database. Do not reset it, stash everything blindly, or run the new startup script over it. `start.sh` currently force-stops processes on ports 8000/5173/5174.

The preparation script makes a private backup and a separate candidate checkout. It does **not** switch the old branch, stop/start processes, install dependencies, call integrations, export process environment secrets, or send outreach. Python 3 and Git are its only dependencies.

## Run in the existing Codespace terminal

Pause source-file editing while this runs. SQLite can remain open: the online backup API includes committed WAL data. Confirm the paths below are the actual runtime data paths. If startup configuration overrides `DATABASE_PATH` or `COMPANIES_PATH`, pass those resolved paths instead. The script does not infer a running process's environment.

This command fetches both refs, reads the reviewed helper directly from its branch, and stages the latest fetched `main`. It does not merge or check out either branch over your work:

```bash
git fetch origin main chore/safe-codespace-upgrade && \
upgrade_script="$(mktemp /tmp/onemonetry-upgrade-XXXXXX.py)" && \
git show origin/chore/safe-codespace-upgrade:scripts/prepare-codespace-upgrade.py > "$upgrade_script" && \
python3 "$upgrade_script" \
  --source "$PWD" \
  --target-ref origin/main \
  --database "$PWD/mock-backend/onemonetry.db" \
  --companies "$PWD/mock-backend/companies.json"
```

Run from `/workspaces/onemonetry`. Once this PR is merged and the helper branch is deleted, use `git fetch origin main` and `git show origin/main:scripts/prepare-codespace-upgrade.py` instead.

The last line should say `PREPARED: /workspaces/onemonetry-upgrades/...`. Only share that result or an error message; do not upload the backup or paste configuration contents. Nothing is deployed by this command.

## What it preserves

Each run creates a new directory, accessible only to your account, outside the source checkout:

- `backup/history.bundle`: Git history and refs, verified with Git.
- `backup/staged.patch` and `unstaged.patch`: binary-capable patches preserving the index/worktree distinction.
- `backup/source.tar`: current source, untracked and ignored local files, including local configuration. Excludes Git internals, dependency directories, cache directories, frontend build output, and SQLite files/sidecars.
- `backup/database-*.sqlite`: independent online snapshots of SQLite files found in the checkout, plus the explicitly selected database. Each passes `PRAGMA quick_check` and has a SHA-256 checksum.
- `backup/companies.json`: checked copy of the explicitly selected companies file.
- `candidate/`: an independent Git clone, detached at the selected merged commit. Unfinished old work is archived for reconciliation; it is not silently applied to the new version.
- `candidate-data/`: separate working copies of the chosen database and company file. The original backup remains separate from these copies.
- `manifest.json`: commit identities, paths and checksums; no environment variable values.
- `NEXT-STEPS.txt`: review and cutover requirements.

The script checks available disk space conservatively. Source edits, symlinks outside excluded directories, unreadable files, invalid database/companies paths, or failed snapshots stop preparation. A failed run retains an `INCOMPLETE` marker and must not be treated as a usable prepared candidate. No cleanup deletes previous backups. The snapshots of multiple databases and JSON files are **not one cross-file transaction**; pause all writers for a final cutover snapshot.

These backups can contain API keys, contacts and authentication records. Keep them private. Secrets supplied only through the Codespace environment remain there and must be configured separately in any new runtime. External configuration/file paths other than the explicit database and companies file are not backed up. This is a same-disk recovery copy, not disaster recovery: transfer it to protected off-machine storage before deleting the Codespace.

## Next review and cutover

1. Compare the archived patches against the merged code, especially the unfinished Gemini/YAMM work. Resolve relevant changes in a new Git branch and test them.
2. Review runtime configuration and external paths. Selectively restore required local files; do not blindly restore the old environment file into the candidate. Set absolute `DATABASE_PATH` and `COMPANIES_PATH` to the **candidate-data** paths from the manifest.
3. Install dependencies/build in the candidate. Validate copied data offline before enabling credentials or background work. Do not run the existing startup script for a parallel preview: its process-killing behavior is not isolated.
4. Check authentication and provider configuration, then test alert → research → contact selection → reviewed plan without sending or spending enrichment credits. The preparation script does not perform this application validation.
5. Before replacing the running app, pause writes, take a fresh snapshot, and reconcile any activity since preparation. A stale candidate must not drive outreach: its capacity and suppression records may be outdated. Permanent hosting and cutover remain a separate step.

## Recovery drill

Recover into a **new empty directory**, never over a live database or source checkout. Verify `manifest.json` checksums first. Clone `backup/history.bundle`, check out `source_head`, apply `staged.patch` with `git apply --index`, then apply `unstaged.patch` with `git apply`. Restore the private source archive over that recovered checkout to recover untracked/ignored files. Copy the selected verified SQLite snapshot and companies file into separate recovered data paths, configure those absolute paths, and reinstall dependencies. Keep the original backup intact. The automated fixture tests prove bundle/patch recovery, committed WAL recovery and isolation from the source database.

#!/usr/bin/env python3
"""Offline backup and candidate preparation. Never starts or updates the live app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import zipfile

EXCLUDED_DIRS = {'.git', 'node_modules', '__pycache__', '.cache'}
EXCLUDED_PATHS = {'frontend/dist'}
DOWNLOAD_DIRS = {'mock-backend/data', 'mock-backend/mock-backend/data'}
DOWNLOAD_NAME = re.compile(r'Accounts_(?:Bulk|Monthly)_Data-[A-Za-z0-9-]+\.zip')


def git(source, *args):
    result = subprocess.run(['git', '-C', str(source), *args], capture_output=True, check=False,
                            env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
    if result.returncode:
        # Git stderr can include authenticated remote URLs. Keep it out of terminal output.
        raise RuntimeError('Git operation failed: ' + args[0])
    return result.stdout


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def signature(path):
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns, stat.st_ino


def inventory(source):
    files, databases = [], []
    for root, dirs, names in os.walk(source, followlinks=False):
        parent = Path(root)
        dirs[:] = [name for name in dirs if name not in EXCLUDED_DIRS
                   and (parent / name).relative_to(source).as_posix() not in EXCLUDED_PATHS]
        for name in [*dirs, *names]:
            path = parent / name
            if path.is_symlink():
                raise RuntimeError('Source contains a symlink outside excluded dependencies; review it before backup.')
        for name in names:
            path = parent / name
            if not path.is_file():
                raise RuntimeError('Source contains a special file; review it before backup.')
            with path.open('rb') as stream:
                is_database = stream.read(16) == b'SQLite format 3\x00'
            (databases if is_database else files).append(path)
    companions = {Path(str(db) + suffix) for db in databases for suffix in ('-wal', '-shm', '-journal')}
    return sorted(set(files) - companions), sorted(databases)


def downloads_to_leave(source, files, protected):
    # Only ignored, untracked CH account ZIPs in the two known download folders.
    # Never omit whole directories: they can contain other state or user work.
    ignored = set(git(source, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z',
                      '--', *sorted(DOWNLOAD_DIRS)).split(b'\0'))
    selected = []
    for path in files:
        relative = path.relative_to(source)
        if (path not in protected and relative.parent.as_posix() in DOWNLOAD_DIRS
                and DOWNLOAD_NAME.fullmatch(path.name)
                and os.fsencode(relative.as_posix()) in ignored and zipfile.is_zipfile(path)):
            selected.append(path)
    return selected


def snapshot_database(source, target, timeout=300):
    started = time.monotonic()
    def progress(_status, _remaining, _total):
        if time.monotonic() - started > timeout:
            raise RuntimeError('Database backup timed out; pause writers and retry.')
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as original:
        with sqlite3.connect(target) as backup:
            original.backup(backup, pages=1024, progress=progress, sleep=0.1)
            if backup.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                raise RuntimeError('Database backup integrity check failed.')


def stable_copy(source, target):
    before = signature(source)
    shutil.copyfile(source, target)
    if before != signature(source) or digest(source) != digest(target):
        raise RuntimeError('A source file changed while copying; pause edits and retry.')


def sqlite_snapshot_size(path):
    # The backup API copies logical database pages, not the whole WAL history.
    # page_count includes committed pages that have not reached the main file yet.
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as connection:
        connection.execute('BEGIN')
        pages = connection.execute('PRAGMA page_count').fetchone()[0]
        page_size = connection.execute('PRAGMA page_size').fetchone()[0]
        return pages * page_size


def estimate_space(source, target, files, databases, database, companies, patch_bytes):
    git_dir = Path(git(source, 'rev-parse', '--absolute-git-dir').decode().strip())
    git_size = sum(p.stat().st_size for p in git_dir.rglob('*') if p.is_file())
    # Only tracked files in the selected commit become the candidate checkout.
    # Ignored downloads/exports are archived once, not copied into candidate.
    checkout_size = 0
    for entry in git(source, 'ls-tree', '-rlz', target).split(b'\0'):
        if not entry:
            continue
        metadata = entry.split(b'\t', 1)[0].split()
        if metadata[1] == b'blob':
            checkout_size += ((int(metadata[3]) + 4095) // 4096) * 4096
    snapshots = {path: sqlite_snapshot_size(path) for path in databases}
    components = {
        # Include tar block rounding and per-file headers, including PAX metadata.
        'source archive': sum(((p.stat().st_size + 511) // 512) * 512 + 4096 for p in files) + 10240,
        'candidate tracked files': checkout_size,
        # Retain conservative room for bundle, independent clone and local fetch.
        'Git history copies': 3 * git_size,
        'SQLite snapshots and candidate database': sum(snapshots.values()) + snapshots[database],
        'company copies and patches': 2 * companies.stat().st_size + patch_bytes,
    }
    components['growth and overhead reserve'] = (sum(components.values()) + 3) // 4 + 256 * 1024 * 1024
    return components


def space_report(output_base, components):
    # Inspect the destination filesystem without creating any backup directories.
    existing = output_base
    while not existing.exists():
        existing = existing.parent
    available = shutil.disk_usage(existing).free
    required = sum(components.values())
    mib = 1024 ** 2
    print(f'SPACE: available {available / mib:.1f} MiB; estimated required {required / mib:.1f} MiB.', flush=True)
    for label, size in components.items():
        print(f'  {label}: {size / mib:.1f} MiB', flush=True)
    print('SPACE CHECK: ' + ('PASS' if available >= required else 'INSUFFICIENT'), flush=True)
    return available, required


def prepare(source, target_ref, database, companies, output_base, check_space=False, leave_downloads=False):
    source, database, companies = (p.resolve(strict=True) for p in (source, database, companies))
    output_base = output_base.resolve()
    if output_base == source or source in output_base.parents:
        raise RuntimeError('Backup destination must be outside the source repository.')
    if Path(git(source, 'rev-parse', '--show-toplevel').decode().strip()).resolve() != source:
        raise RuntimeError('--source must be the repository root.')
    if not database.is_file() or not companies.is_file():
        raise RuntimeError('Database and companies paths must be regular files.')
    with database.open('rb') as stream:
        if stream.read(16) != b'SQLite format 3\x00':
            raise RuntimeError('Selected database is not an initialized SQLite file; check the live path.')
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
        connection.execute('SELECT count(*) FROM sqlite_master').fetchone()
    with companies.open() as stream:
        if not isinstance(json.load(stream), list):
            raise RuntimeError('Companies file must contain a JSON array.')
    target = git(source, 'rev-parse', '--verify', target_ref + '^{commit}').decode().strip()
    head = git(source, 'rev-parse', 'HEAD').decode().strip()
    status = git(source, 'status', '--porcelain=v1', '-z')
    index_diff = git(source, 'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv')
    working_diff = git(source, 'diff', '--binary', '--no-ext-diff', '--no-textconv')
    files, databases = inventory(source)
    databases = sorted(set(databases + [database]))
    signatures = {p: signature(p) for p in files}
    left_in_place = downloads_to_leave(source, files, {database, companies}) if leave_downloads else []
    archive_files = sorted(set(files) - set(left_in_place))
    if left_in_place:
        size = sum(p.stat().st_size for p in left_in_place)
        print(f'LEAVING IN PLACE: {len(left_in_place)} account download ZIPs ({size / (1024 ** 2):.1f} MiB). '
              'Their contents will not be included in this backup; originals are not modified.', flush=True)
    components = estimate_space(source, target, archive_files, databases, database, companies,
                                len(index_diff) + len(working_diff) + len(status))
    available, required = space_report(output_base, components)
    if check_space:
        print('Space report only; no backup or candidate created.', flush=True)
        return None
    if available < required:
        raise RuntimeError('Insufficient free disk space. Share the SPACE report above; do not delete live data.')
    os.umask(0o077)
    output_base.mkdir(parents=True, exist_ok=True)
    destination = Path(tempfile.mkdtemp(prefix=time.strftime('%Y%m%d-%H%M%S-'), dir=output_base))
    print(f'Preparing private backup: {destination}', flush=True)
    (destination / 'INCOMPLETE').write_text('Do not use this directory until preparation finishes.\n')
    backups = destination / 'backup'
    backups.mkdir()
    git(source, 'bundle', 'create', str(backups / 'history.bundle'), '--all', 'HEAD', target)
    git(source, 'bundle', 'verify', str(backups / 'history.bundle'))
    (backups / 'staged.patch').write_bytes(index_diff)
    (backups / 'unstaged.patch').write_bytes(working_diff)
    (backups / 'git-status.z').write_bytes(status)
    download_records = []
    for index, path in enumerate(left_in_place):
        print(f'Recording checksum for download left in place {index + 1}/{len(left_in_place)}.', flush=True)
        download_records.append({'path': str(path.relative_to(source)), 'bytes': signatures[path][0],
                                 'sha256': digest(path), 'backed_up': False})
        if signatures[path] != signature(path):
            raise RuntimeError('A download changed while recording its checksum; pause downloads and retry.')
    if download_records:
        (backups / 'left-in-place-downloads.json').write_text(json.dumps(download_records, indent=2) + '\n')
    print('Saving source files and unfinished work (including private local configuration).', flush=True)
    with tarfile.open(backups / 'source.tar', 'w') as archive:
        for path in archive_files:
            archive.add(path, arcname=str(path.relative_to(source)), recursive=False)
            if signatures[path] != signature(path):
                raise RuntimeError('Source changed during backup; pause edits and retry.')
    stable_copy(companies, backups / 'companies.json')
    database_records = []
    for index, path in enumerate(databases):
        print(f'Creating and checking SQLite snapshot {index + 1}/{len(databases)}.', flush=True)
        backup = backups / f'database-{index + 1}.sqlite'
        snapshot_database(path, backup)
        database_records.append({'source': str(path), 'backup': backup.name, 'sha256': digest(backup)})
    current_files, current_databases = inventory(source)
    if (git(source, 'rev-parse', 'HEAD').decode().strip() != head
            or git(source, 'status', '--porcelain=v1', '-z') != status
            or git(source, 'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv') != index_diff
            or current_files != files
            or sorted(set(current_databases + [database])) != databases
            or any(signature(p) != stamp for p, stamp in signatures.items())):
        raise RuntimeError('Source changed during preparation; pause edits and retry.')
    print('Preparing the selected commit in a separate, stopped checkout.', flush=True)
    candidate = destination / 'candidate'
    git(source, 'clone', '--no-hardlinks', '--no-checkout', str(source), str(candidate))
    # A local clone might not copy an unreferenced target commit. Fetch it from the local source.
    git(candidate, 'fetch', str(source), target)
    git(candidate, 'checkout', '--detach', target)
    git(candidate, 'remote', 'set-url', 'origin', git(source, 'remote', 'get-url', 'origin').decode().strip())
    data = destination / 'candidate-data'
    data.mkdir()
    primary = next(record for record in database_records if record['source'] == str(database))
    shutil.copyfile(backups / primary['backup'], data / 'onemonetry.db')
    shutil.copyfile(backups / 'companies.json', data / 'companies.json')
    if digest(data / 'onemonetry.db') != primary['sha256']:
        raise RuntimeError('Candidate database differs from verified backup.')
    manifest = {
        'status': 'prepared_not_started', 'source': str(source), 'source_head': head,
        'target_commit': target, 'candidate': str(candidate),
        'database_path': str(data / 'onemonetry.db'), 'companies_path': str(data / 'companies.json'),
        'database_snapshots': database_records,
        'downloads_left_in_place': download_records,
        'backup_sha256': {p.name: digest(p) for p in backups.iterdir() if p.is_file()},
        'excluded_directories': sorted(EXCLUDED_DIRS | EXCLUDED_PATHS),
        'credentials': 'Local files archived privately; process environment secrets are not exported.',
    }
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (destination / 'NEXT-STEPS.txt').write_text(
        'PREPARED ONLY: the live app has not been stopped or changed.\n'
        'Do not run start.sh or npm run start:dev in candidate: they stop existing port processes.\n'
        'Before starting candidate, review staged.patch and unstaged.patch against target,\n'
        'restore any required runtime files from source.tar selectively, and configure runtime secrets.\n'
        'Set DATABASE_PATH and COMPANIES_PATH to the absolute paths in manifest.json.\n'
        'Review external file paths in existing configuration; never point candidate at live data.\n'
        'Install dependencies and build only inside candidate. Test offline on the copied data first.\n'
        'Do not use candidate for outreach: live activity after the snapshot is missing.\n'
        'Cutover requires pausing live writes, a fresh snapshot, and a separate validation step.\n'
        'Keep backup private: it can contain API keys, contact data and authentication records.\n'
        'This backup is on the same disk. Copy it to protected off-machine storage before deleting the Codespace.\n'
        + ('Some downloaded ZIPs remain only in the original checkout, listed in left-in-place-downloads.json.\n'
           'Preserve those originals separately before deleting the old checkout or Codespace.\n'
           if download_records else '')
    )
    (destination / 'INCOMPLETE').unlink()
    print(f'PREPARED: {destination}\nLive app unchanged. No integrations called or services started.', flush=True)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path.cwd())
    parser.add_argument('--target-ref', required=True, help='Previously fetched commit or ref; no remote fetch is performed')
    parser.add_argument('--database', type=Path, required=True, help='Actual live SQLite path')
    parser.add_argument('--companies', type=Path, required=True, help='Actual live companies JSON path')
    parser.add_argument('--output-base', type=Path, help='Private backup parent outside the repo')
    parser.add_argument('--check-space', action='store_true', help='Only report space needs; do not create a backup or candidate')
    parser.add_argument('--leave-downloads', action='store_true',
                        help='Leave ignored CH account ZIPs in place and record checksums instead of duplicating them')
    args = parser.parse_args()
    try:
        prepare(args.source, args.target_ref, args.database, args.companies,
                args.output_base or args.source.resolve().parent / 'onemonetry-upgrades',
                args.check_space, args.leave_downloads)
    except RuntimeError as error:
        print(f'Preparation stopped: {error}', flush=True)
        print('Live files were not changed. Any INCOMPLETE folder must not be used.', flush=True)
        raise SystemExit(1)
    except (OSError, ValueError, sqlite3.Error, tarfile.TarError):
        # Avoid echoing file contents, environment values or authenticated URLs from exceptions.
        print('Preparation failed. Live files were not changed. Any INCOMPLETE folder must not be used.', flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()

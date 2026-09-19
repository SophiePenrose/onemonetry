#!/usr/bin/env python3
"""Offline backup and candidate preparation. Never starts or updates the live app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time

EXCLUDED_DIRS = {'.git', 'node_modules', '__pycache__', '.cache'}
EXCLUDED_PATHS = {'frontend/dist'}


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


def prepare(source, target_ref, database, companies, output_base):
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
    git_dir = Path(git(source, 'rev-parse', '--absolute-git-dir').decode().strip())
    git_size = sum(p.stat().st_size for p in git_dir.rglob('*') if p.is_file())
    # Source archive, independent candidate checkout, bundle/clone, backup + working DB copy.
    required = 2 * sum(p.stat().st_size for p in files) + 3 * git_size
    required += sum(p.stat().st_size for p in databases) + database.stat().st_size
    required += sum(Path(str(p) + '-wal').stat().st_size for p in databases if Path(str(p) + '-wal').exists()) * 2
    required = int(required * 1.25) + 256 * 1024 * 1024
    output_base.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(output_base).free < required:
        raise RuntimeError(f'Insufficient free disk space; need approximately {required // (1024 ** 2)} MiB.')
    os.umask(0o077)
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
    print('Saving source files and unfinished work (including private local configuration).', flush=True)
    with tarfile.open(backups / 'source.tar', 'w') as archive:
        for path in files:
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
    args = parser.parse_args()
    try:
        prepare(args.source, args.target_ref, args.database, args.companies,
                args.output_base or args.source.resolve().parent / 'onemonetry-upgrades')
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

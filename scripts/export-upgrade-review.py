#!/usr/bin/env python3
"""Export saved code changes for review without database, download or environment files."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
import zipfile

SOURCE_DIRS = {'frontend', 'mock-backend', 'scripts', 'docs', 'prompts'}
SOURCE_SUFFIXES = {'.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.sh', '.css', '.md', '.html', '.sql'}
ROOT_FILES = {'package.json', 'package-lock.json', 'start.sh', '.devcontainer/devcontainer.json',
              'AGENTS.md', 'README.md', 'server.js', 'docker-compose.yml',
              'master_prompt_outline_v2.md', 'revolut_prospecting_app_supplementary_context.md'}
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 100 * 1024 * 1024


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def read_status(raw):
    parts = iter(raw.decode('utf-8').split('\0'))
    records = []
    for part in parts:
        if not part:
            continue
        if len(part) < 4 or part[2] != ' ':
            raise RuntimeError('Invalid saved Git status.')
        record = {'status': part[:2], 'path': part[3:]}
        if 'R' in part[:2] or 'C' in part[:2]:
            record['original_path'] = next(parts)
        records.append(record)
    return records


def source_allowed(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        return False
    if name in ROOT_FILES:
        return True
    if path.parts[:2] == ('.github', 'workflows') and len(path.parts) == 3:
        return path.suffix in {'.yml', '.yaml'}
    if path.parts[0] not in SOURCE_DIRS:
        return False
    if any(part.startswith('.') or part in {'node_modules', 'data', 'exports', 'dist', '__pycache__'}
           for part in path.parts[1:]):
        return False
    return (path.suffix in SOURCE_SUFFIXES or path.name in {'package.json', 'package-lock.json'}
            or (path.parts[0] == 'prompts' and path.suffix == '.txt'))


def git_read(prepared, *args):
    # Read immutable objects already copied by preparation. No checkout, hooks,
    # application execution, remote access or additional history copy is needed.
    git_dir = prepared / 'candidate' / '.git'
    if git_dir.is_symlink() or not git_dir.is_dir():
        raise RuntimeError('The prepared candidate Git directory is unavailable.')
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
               GIT_NO_REPLACE_OBJECTS='1', GIT_OPTIONAL_LOCKS='0')
    result = subprocess.run(['git', '--git-dir=' + str(git_dir), *args],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, check=False)
    if result.returncode:
        raise RuntimeError('The saved source commit could not be read from the prepared candidate.')
    return result.stdout


def baseline_entries(prepared, commit):
    if git_read(prepared, 'rev-parse', '--verify', commit + '^{commit}').decode().strip() != commit:
        raise RuntimeError('Saved source commit verification failed.')
    entries = []
    for row in git_read(prepared, 'ls-tree', '-rlz', '--full-tree', commit).split(b'\0'):
        if not row:
            continue
        meta, raw_path = row.split(b'\t', 1)
        name = raw_path.decode('utf-8')
        if not source_allowed(name):
            continue
        mode, kind, sha, size = meta.decode('ascii').split()
        if mode not in {'100644', '100755'} or kind != 'blob' or int(size) > MAX_FILE_BYTES:
            raise RuntimeError('A selected baseline entry is not a regular file under 4 MiB.')
        entries.append((name, sha, int(size)))
    return entries


def export_review(prepared, output_dir, include_baseline=False):
    prepared = prepared.resolve(strict=True)
    output_dir = output_dir.resolve()
    if output_dir == prepared or prepared in output_dir.parents:
        raise RuntimeError('Keep the review bundle outside the preserved backup folder.')
    if (prepared / 'INCOMPLETE').exists():
        raise RuntimeError('Cannot export an incomplete backup.')
    manifest = json.loads((prepared / 'manifest.json').read_text())
    if manifest['status'] != 'prepared_not_started':
        raise RuntimeError('Unrecognized backup status.')
    for key in ('source_head', 'target_commit'):
        if not re.fullmatch('[a-f0-9]{40}', manifest[key]):
            raise RuntimeError('Invalid saved commit identifier.')
    backup = prepared / 'backup'
    print('Checking the saved source archive and change list.', flush=True)
    for name in ('source.tar', 'git-status.z'):
        if digest(backup / name) != manifest['backup_sha256'][name]:
            raise RuntimeError('Saved backup checksum mismatch; no review bundle created.')
    records = read_status((backup / 'git-status.z').read_bytes())
    names = {record['path'] for record in records}
    prefixes = tuple(name for name in names if name.endswith('/'))
    baseline = baseline_entries(prepared, manifest['source_head']) if include_baseline else []
    if sum(size for _, _, size in baseline) > MAX_TOTAL_BYTES:
        raise RuntimeError('Selected review source exceeds the 100 MiB limit.')
    os.umask(0o077)
    output_dir.mkdir(parents=True, exist_ok=True)
    fd, filename = tempfile.mkstemp(prefix='onemonetry-code-review-', suffix='.zip', dir=output_dir)
    output = Path(filename)
    included = []
    total_bytes = 0
    try:
        with os.fdopen(fd, 'wb') as destination, zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as bundle:
            if include_baseline:
                print('Reading original committed code from the existing candidate Git objects.', flush=True)
            for name, sha, size in baseline:
                contents = git_read(prepared, 'cat-file', 'blob', sha)
                if len(contents) != size:
                    raise RuntimeError('Saved baseline blob size mismatch.')
                bundle.writestr('base/' + name, contents)
                total_bytes += size
            with tarfile.open(backup / 'source.tar', 'r:') as archive:
                for member in archive:
                    name = member.name
                    if not source_allowed(name):
                        continue
                    if not include_baseline and name not in names and not name.startswith(prefixes):
                        continue
                    if not member.isfile() or member.size > MAX_FILE_BYTES:
                        raise RuntimeError('A selected source entry is not a regular file under 4 MiB.')
                    if name in included:
                        raise RuntimeError('Duplicate source entry in saved archive.')
                    total_bytes += member.size
                    if total_bytes > MAX_TOTAL_BYTES:
                        raise RuntimeError('Selected review source exceeds the 100 MiB limit.')
                    with archive.extractfile(member) as stream:
                        bundle.writestr('source/' + name, stream.read())
                    included.append(name)
            info = {
                'source_head': manifest['source_head'], 'target_commit': manifest['target_commit'],
                'saved_git_status': records, 'included_source_files': included,
                'format_version': 2, 'includes_baseline': include_baseline,
                'included_base_files': [name for name, _, _ in baseline],
                'source_scope': 'all_allowed_saved_source' if include_baseline else 'changed_allowed_source',
                'uncompressed_bytes': total_bytes,
                'note': 'source/ contains final saved file versions; base/ contains original committed versions '
                        'when includes_baseline is true. Inspect renames/deletions in saved_git_status. '
                        'Unlisted data, works/, runtime configuration and binary files are not included. '
                        'This is a code review bundle, not a replacement for the full backup.',
            }
            bundle.writestr('review-info.json', json.dumps(info, indent=2) + '\n')
        print(f'REVIEW BUNDLE: {output}\nIncluded {len(included)} saved source files and '
              f'{len(baseline)} baseline files; {output.stat().st_size / 1024:.0f} KiB.', flush=True)
        return output
    except BaseException:
        output.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepared', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--include-baseline', action='store_true',
                        help='Include all allowed saved source and original committed code for reconciliation')
    args = parser.parse_args()
    try:
        export_review(args.prepared, args.output_dir, args.include_baseline)
    except (OSError, ValueError, KeyError, StopIteration, RuntimeError, tarfile.TarError):
        print('Review export failed. The original project and preserved backup were not changed.', flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Export saved code changes for review without database, download or environment files."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile
import zipfile

SOURCE_DIRS = {'frontend', 'mock-backend', 'scripts', 'docs'}
SOURCE_SUFFIXES = {'.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.sh', '.css', '.md'}
ROOT_FILES = {'package.json', 'package-lock.json', 'start.sh', '.devcontainer/devcontainer.json'}


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
    if path.parts[0] not in SOURCE_DIRS:
        return False
    if any(part.startswith('.') or part in {'node_modules', 'data', 'exports', 'dist', '__pycache__'}
           for part in path.parts[1:]):
        return False
    return path.suffix in SOURCE_SUFFIXES or path.name in {'package.json', 'package-lock.json'}


def export_review(prepared, output_dir):
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
    os.umask(0o077)
    output_dir.mkdir(parents=True, exist_ok=True)
    fd, filename = tempfile.mkstemp(prefix='onemonetry-code-review-', suffix='.zip', dir=output_dir)
    output = Path(filename)
    included = []
    try:
        with os.fdopen(fd, 'wb') as destination, zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as bundle:
            with tarfile.open(backup / 'source.tar', 'r:') as archive:
                for member in archive:
                    name = member.name
                    if (name not in names and not name.startswith(prefixes)) or not source_allowed(name):
                        continue
                    if not member.isfile() or member.size > 4 * 1024 * 1024:
                        raise RuntimeError('A selected source entry is not a regular file under 4 MiB.')
                    if name in included:
                        raise RuntimeError('Duplicate source entry in saved archive.')
                    with archive.extractfile(member) as stream:
                        bundle.writestr('source/' + name, stream.read())
                    included.append(name)
            info = {
                'source_head': manifest['source_head'], 'target_commit': manifest['target_commit'],
                'saved_git_status': records, 'included_source_files': included,
                'note': 'Final saved file versions only. Inspect renames/deletions in saved_git_status. '
                        'Unlisted data, works/, runtime configuration and binary files are not included. '
                        'This is a code review bundle, not a replacement for the full backup.',
            }
            bundle.writestr('review-info.json', json.dumps(info, indent=2) + '\n')
        print(f'REVIEW BUNDLE: {output}\nIncluded {len(included)} source files; {output.stat().st_size / 1024:.0f} KiB.', flush=True)
        return output
    except BaseException:
        output.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepared', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    try:
        export_review(args.prepared, args.output_dir)
    except (OSError, ValueError, KeyError, StopIteration, RuntimeError, tarfile.TarError):
        print('Review export failed. The original project and preserved backup were not changed.', flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()

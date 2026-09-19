import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('review', Path(__file__).parents[1] / 'export-upgrade-review.py')
review = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(review)


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.prepared = self.root / 'prepared'
        backup = self.prepared / 'backup'
        backup.mkdir(parents=True)
        self.contents = {
            'frontend/App.jsx': b'updated code',
            'frontend/pages/ActiveOpportunities.jsx': b'new page',
            'scripts/backfill-ready-filing-coverage.mjs': b'new script',
            'mock-backend/db.js': b'unchanged file not requested',
            '.env': b'PRIVATE_SECRET=fixture',
            'mock-backend/data/private.js': b'private download',
            'exports/contact-data.csv': b'private contacts',
            'works/private.py': b'private out-of-scope work',
        }
        with tarfile.open(backup / 'source.tar', 'w') as archive:
            for name, contents in self.contents.items():
                item = tarfile.TarInfo(name)
                item.size = len(contents)
                archive.addfile(item, io.BytesIO(contents))
        (backup / 'git-status.z').write_bytes(
            b' M frontend/App.jsx\0?? frontend/pages/ActiveOpportunities.jsx\0?? scripts/\0'
            b'?? .env\0?? mock-backend/data/\0?? exports/\0?? works/\0 D frontend/Deleted.jsx\0')
        self.manifest = {'status': 'prepared_not_started', 'source_head': 'a' * 40, 'target_commit': 'b' * 40,
                         'backup_sha256': {name: review.digest(backup / name) for name in ('source.tar', 'git-status.z')}}
        (self.prepared / 'manifest.json').write_text(json.dumps(self.manifest))

    def export(self, **options):
        with contextlib.redirect_stdout(io.StringIO()):
            return review.export_review(self.prepared, self.root / 'exports', **options)

    def make_baseline(self):
        candidate = self.prepared / 'candidate'
        candidate.mkdir()
        def git(*args):
            return subprocess.check_output(['git', '-C', str(candidate), *args], stderr=subprocess.DEVNULL)
        git('init', '-b', 'fixture')
        git('config', 'user.name', 'Fixture')
        git('config', 'user.email', 'fixture@example.invalid')
        contents = {
            'frontend/App.jsx': 'original committed app',
            'frontend/Deleted.jsx': 'deleted locally',
            'mock-backend/db.js': 'unchanged file not requested',
            'frontend/pages/CustomGemHandoff.jsx': 'unchanged dependency',
            'prompts/email.txt': 'calibrated instructions',
            '.env': 'PRIVATE_SECRET=baseline-fixture',
            'mock-backend/data/private.js': 'private download',
            'exports/private.json': 'private contacts',
        }
        for name, content in contents.items():
            path = candidate / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        git('add', '.')
        git('commit', '-qm', 'source baseline')
        commit = git('rev-parse', 'HEAD').decode().strip()
        self.manifest['source_head'] = commit
        (self.prepared / 'manifest.json').write_text(json.dumps(self.manifest))
        # Candidate is checked out at a different target, just like real preparation.
        (candidate / 'frontend/App.jsx').write_text('current main app')
        git('commit', '-qam', 'candidate target')
        return candidate, git

    def test_baseline_includes_original_commit_and_unchanged_saved_dependencies(self):
        candidate, git = self.make_baseline()
        before = git('rev-parse', 'HEAD')
        output = self.export(include_baseline=True)
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(archive.read('base/frontend/App.jsx'), b'original committed app')
            self.assertEqual(archive.read('source/frontend/App.jsx'), b'updated code')
            self.assertEqual(archive.read('source/mock-backend/db.js'), b'unchanged file not requested')
            self.assertEqual(archive.read('base/frontend/pages/CustomGemHandoff.jsx'), b'unchanged dependency')
            self.assertIn('base/frontend/Deleted.jsx', archive.namelist())
            self.assertNotIn('source/frontend/Deleted.jsx', archive.namelist())
            self.assertIn('base/prompts/email.txt', archive.namelist())
            for name in archive.namelist():
                self.assertNotIn('/.env', name)
                self.assertNotIn('/data/', name)
                self.assertNotIn('/exports/', name)
                self.assertNotIn('/works/', name)
            info = json.loads(archive.read('review-info.json'))
            self.assertTrue(info['includes_baseline'])
            self.assertEqual(info['source_scope'], 'all_allowed_saved_source')
        self.assertEqual(git('rev-parse', 'HEAD'), before)
        self.assertEqual(git('status', '--porcelain'), b'')
        self.assertEqual(review.digest(self.prepared / 'backup/source.tar'), self.manifest['backup_sha256']['source.tar'])

    def test_baseline_ignores_inherited_git_object_and_worktree_overrides(self):
        self.make_baseline()
        with patch.dict(os.environ, {'GIT_OBJECT_DIRECTORY': '/missing-fixture-objects',
                                     'GIT_WORK_TREE': '/missing-fixture-worktree'}):
            self.assertTrue(self.export(include_baseline=True).is_file())

    def test_missing_baseline_fails_without_creating_output(self):
        self.make_baseline()
        self.manifest['source_head'] = 'c' * 40
        (self.prepared / 'manifest.json').write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(RuntimeError, 'saved source commit'):
            self.export(include_baseline=True)
        self.assertFalse((self.root / 'exports').exists())

    def test_symlink_in_baseline_is_rejected_without_reading_target(self):
        candidate, git = self.make_baseline()
        (candidate / 'frontend/linked.js').symlink_to(self.root / 'private-file')
        git('add', '.')
        git('commit', '-qm', 'unsafe baseline')
        self.manifest['source_head'] = git('rev-parse', 'HEAD').decode().strip()
        (self.prepared / 'manifest.json').write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(RuntimeError, 'regular file'):
            self.export(include_baseline=True)
        self.assertFalse((self.root / 'exports').exists())

    def test_total_size_limit_removes_partial_output(self):
        self.make_baseline()
        baseline_size = sum(size for _, _, size in review.baseline_entries(self.prepared, self.manifest['source_head']))
        with patch.object(review, 'MAX_TOTAL_BYTES', baseline_size + 1):
            with self.assertRaisesRegex(RuntimeError, '100 MiB'):
                self.export(include_baseline=True)
        self.assertEqual(list((self.root / 'exports').glob('*.zip')), [])

    def test_exports_changed_and_new_code_without_unrelated_or_private_files(self):
        output = self.export()
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(set(archive.namelist()), {
                'source/frontend/App.jsx', 'source/frontend/pages/ActiveOpportunities.jsx',
                'source/scripts/backfill-ready-filing-coverage.mjs', 'review-info.json'})
            self.assertEqual(archive.read('source/frontend/App.jsx'), b'updated code')
            info = json.loads(archive.read('review-info.json'))
            self.assertIn({'status': ' D', 'path': 'frontend/Deleted.jsx'}, info['saved_git_status'])
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(review.digest(self.prepared / 'backup/source.tar'), self.manifest['backup_sha256']['source.tar'])

    def test_rejects_incomplete_backup(self):
        (self.prepared / 'INCOMPLETE').touch()
        with self.assertRaisesRegex(RuntimeError, 'incomplete'):
            self.export()
        self.assertFalse((self.root / 'exports').exists())

    def test_detects_corrupted_saved_archive_before_creating_output(self):
        with (self.prepared / 'backup/source.tar').open('ab') as stream:
            stream.write(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            self.export()
        self.assertFalse((self.root / 'exports').exists())

    def test_parses_renames_and_new_names_with_spaces(self):
        self.assertEqual(review.read_status(b'R  frontend/New.jsx\0frontend/Old.jsx\0?? scripts/new script.py\0'), [
            {'status': 'R ', 'path': 'frontend/New.jsx', 'original_path': 'frontend/Old.jsx'},
            {'status': '??', 'path': 'scripts/new script.py'}])

    def test_disallows_traversal_environment_data_and_dependency_files(self):
        for name in ('frontend/../.env', '/frontend/app.js', 'frontend/.env',
                     'frontend/node_modules/file.js', 'mock-backend/data/test.js', 'CH-dossier.json'):
            self.assertFalse(review.source_allowed(name), name)
        self.assertTrue(review.source_allowed('.devcontainer/devcontainer.json'))
        self.assertTrue(review.source_allowed('scripts/build-final-yamm-merge.py'))


if __name__ == '__main__':
    unittest.main()

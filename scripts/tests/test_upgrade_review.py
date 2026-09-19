import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

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

    def export(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return review.export_review(self.prepared, self.root / 'exports')

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

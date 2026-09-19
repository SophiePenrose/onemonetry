import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('upgrade', Path(__file__).parents[1] / 'prepare-codespace-upgrade.py')
upgrade = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upgrade)


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / 'source'
        self.source.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        self.git('remote', 'add', 'origin', 'https://example.invalid/local-fixture.git')
        (self.source / '.gitignore').write_text('.env\n*.db*\nnode_modules/\n')
        (self.source / 'app.txt').write_text('old committed app\n')
        self.git('add', '.')
        self.git('commit', '-m', 'old version')
        self.old = self.git('rev-parse', 'HEAD').strip()
        (self.source / 'app.txt').write_text('merged app\n')
        self.git('commit', '-am', 'merged version')
        self.target = self.git('rev-parse', 'HEAD').strip()
        self.git('checkout', '-b', 'unfinished-work', self.old)
        (self.source / 'app.txt').write_text('staged user work\n')
        self.git('add', 'app.txt')
        (self.source / 'app.txt').write_text('additional unstaged user work\n')
        (self.source / 'untracked.txt').write_text('keep me\n')
        (self.source / '.env').write_text('API_KEY=synthetic-fixture-secret\n')
        (self.source / 'node_modules').mkdir()
        (self.source / 'node_modules' / 'excluded').write_text('dependency')
        self.companies = self.source / 'companies.json'
        self.companies.write_text('[{"number":"00000001"}]')
        self.database = self.source / 'onemonetry.db'
        self.live = sqlite3.connect(self.database)
        self.addCleanup(self.live.close)
        self.live.execute('PRAGMA journal_mode=WAL')
        self.live.execute('CREATE TABLE fixture (value TEXT)')
        self.live.execute("INSERT INTO fixture VALUES ('committed in WAL')")
        self.live.commit()
        self.before = self.git('status', '--porcelain=v1')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.source), *args], stderr=subprocess.DEVNULL).decode()

    def prepare(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return upgrade.prepare(self.source, self.target, self.database, self.companies, self.base / 'backups')

    def test_preserves_work_and_recovers_wal_into_independent_candidate(self):
        result = self.prepare()
        self.assertFalse((result / 'INCOMPLETE').exists())
        self.assertEqual(result.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.git('status', '--porcelain=v1'), self.before)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.old)
        self.assertEqual((self.source / 'app.txt').read_text(), 'additional unstaged user work\n')
        self.assertEqual((result / 'candidate' / 'app.txt').read_text(), 'merged app\n')
        self.assertFalse((result / 'candidate' / '.env').exists())
        manifest = json.loads((result / 'manifest.json').read_text())
        for name, expected in manifest['backup_sha256'].items():
            self.assertEqual(upgrade.digest(result / 'backup' / name), expected)
        with tarfile.open(result / 'backup' / 'source.tar') as archive:
            self.assertEqual(archive.extractfile('.env').read(), b'API_KEY=synthetic-fixture-secret\n')
            self.assertEqual(archive.extractfile('untracked.txt').read(), b'keep me\n')
            self.assertNotIn('onemonetry.db', archive.getnames())
            self.assertNotIn('onemonetry.db-wal', archive.getnames())
            self.assertFalse(any(name.startswith('node_modules') for name in archive.getnames()))
        with sqlite3.connect(manifest['database_path']) as candidate:
            self.assertEqual(candidate.execute('SELECT value FROM fixture').fetchall(), [('committed in WAL',)])
            candidate.execute("INSERT INTO fixture VALUES ('candidate only')")
        self.assertEqual(self.live.execute('SELECT COUNT(*) FROM fixture').fetchone()[0], 1)
        # Prove bundle + the two patches can reconstruct the original index/worktree distinction.
        recovered = self.base / 'recovered'
        subprocess.run(['git', 'clone', '-q', str(result / 'backup' / 'history.bundle'), str(recovered)], check=True)
        upgrade.git(recovered, 'checkout', '--detach', self.old)
        upgrade.git(recovered, 'apply', '--index', str(result / 'backup' / 'staged.patch'))
        upgrade.git(recovered, 'apply', str(result / 'backup' / 'unstaged.patch'))
        self.assertEqual((recovered / 'app.txt').read_text(), (self.source / 'app.txt').read_text())
        self.assertEqual(upgrade.git(recovered, 'show', ':app.txt'), b'staged user work\n')

    def test_refuses_output_inside_live_source(self):
        with self.assertRaisesRegex(RuntimeError, 'outside'):
            upgrade.prepare(self.source, self.target, self.database, self.companies, self.source / 'backups')

    def test_missing_database_does_not_create_an_empty_one(self):
        self.database = self.source / 'missing.db'
        with self.assertRaises(FileNotFoundError):
            self.prepare()
        self.assertFalse(self.database.exists())

    def test_empty_database_is_rejected_without_initializing_it(self):
        self.database = self.base / 'empty.db'
        self.database.touch()
        with self.assertRaisesRegex(RuntimeError, 'initialized SQLite'):
            self.prepare()
        self.assertEqual(self.database.stat().st_size, 0)

    def test_insufficient_space_fails_before_backup(self):
        with patch.object(upgrade.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 0})()):
            with self.assertRaisesRegex(RuntimeError, 'Insufficient'):
                self.prepare()
        self.assertFalse((self.base / 'backups').exists())

    def test_space_report_creates_no_backup_even_when_full(self):
        output = io.StringIO()
        with patch.object(upgrade.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 0})()):
            with contextlib.redirect_stdout(output):
                result = upgrade.prepare(self.source, self.target, self.database, self.companies,
                                         self.base / 'backups', check_space=True)
        self.assertIsNone(result)
        self.assertIn('SPACE CHECK: INSUFFICIENT', output.getvalue())
        self.assertNotIn('synthetic-fixture-secret', output.getvalue())
        self.assertFalse((self.base / 'backups').exists())
        self.assertEqual(self.git('status', '--porcelain=v1'), self.before)

    def estimate(self):
        files, databases = upgrade.inventory(self.source)
        return upgrade.estimate_space(self.source, self.target, files, databases,
                                      self.database, self.companies, 0)

    def test_repeated_wal_updates_do_not_inflate_snapshot_estimate(self):
        self.live.execute('PRAGMA wal_autocheckpoint=0')
        for index in range(100):
            self.live.execute('UPDATE fixture SET value=?', (str(index),))
            self.live.commit()
        expected = self.live.execute('PRAGMA page_count').fetchone()[0] * self.live.execute('PRAGMA page_size').fetchone()[0]
        self.assertGreater(Path(str(self.database) + '-wal').stat().st_size, expected * 20)
        self.assertEqual(self.estimate()['SQLite snapshots and candidate database'], expected * 2)
        backup = self.base / 'verified.db'
        upgrade.snapshot_database(self.database, backup)
        self.assertEqual(backup.stat().st_size, expected)

    def test_new_pages_in_wal_are_included_even_before_checkpoint(self):
        self.live.execute('PRAGMA wal_autocheckpoint=0')
        self.live.execute('INSERT INTO fixture VALUES (?)', ('x' * 1000000,))
        self.live.commit()
        size = upgrade.sqlite_snapshot_size(self.database)
        self.assertGreater(size, self.database.stat().st_size)
        backup = self.base / 'verified.db'
        upgrade.snapshot_database(self.database, backup)
        self.assertEqual(size, backup.stat().st_size)

    def test_local_download_is_archived_once_and_does_not_inflate_checkout(self):
        before = self.estimate()
        download = self.source / 'local-download.zip'
        download.write_bytes(b'x' * 1048576)
        after = self.estimate()
        self.assertEqual(after['candidate tracked files'], before['candidate tracked files'])
        self.assertEqual(after['source archive'] - before['source archive'], 1048576 + 4096)

    def test_checkout_estimate_uses_target_even_if_current_checkout_is_small(self):
        self.git('stash', 'push', '-m', 'fixture only')
        self.git('checkout', 'main')
        (self.source / 'new-tracked-file').write_bytes(b'x' * 1048576)
        self.git('add', 'new-tracked-file')
        self.git('commit', '-m', 'large target file')
        self.target = self.git('rev-parse', 'HEAD').strip()
        self.git('checkout', 'unfinished-work')
        self.assertFalse((self.source / 'new-tracked-file').exists())
        self.assertGreaterEqual(self.estimate()['candidate tracked files'], 1048576)

    def test_source_edit_leaves_incomplete_marker_and_no_candidate(self):
        original = upgrade.snapshot_database
        def changing_snapshot(*args, **kwargs):
            original(*args, **kwargs)
            (self.source / 'untracked.txt').write_text('edited while backing up')
        with patch.object(upgrade, 'snapshot_database', side_effect=changing_snapshot):
            with self.assertRaisesRegex(RuntimeError, 'Source changed'):
                self.prepare()
        result = next((self.base / 'backups').iterdir())
        self.assertTrue((result / 'INCOMPLETE').exists())
        self.assertFalse((result / 'candidate').exists())

    def test_additional_sqlite_is_snapshotted_instead_of_raw_copied(self):
        extra = self.source / 'another.db'
        with sqlite3.connect(extra) as connection:
            connection.execute('CREATE TABLE other (value TEXT)')
        self.before = self.git('status', '--porcelain=v1')
        result = self.prepare()
        manifest = json.loads((result / 'manifest.json').read_text())
        self.assertEqual(len(manifest['database_snapshots']), 2)
        with tarfile.open(result / 'backup' / 'source.tar') as archive:
            self.assertNotIn('another.db', archive.getnames())

    def test_external_database_and_companies_paths(self):
        external = self.base / 'external.db'
        upgrade.snapshot_database(self.database, external)
        self.database = external
        self.companies = self.base / 'external-companies.json'
        self.companies.write_text('[{"number":"external"}]')
        result = self.prepare()
        self.assertEqual(json.loads((result / 'candidate-data' / 'companies.json').read_text())[0]['number'], 'external')

    def test_symlink_is_rejected_without_following_private_target(self):
        (self.source / 'linked-file').symlink_to(self.base / 'outside')
        with self.assertRaisesRegex(RuntimeError, 'symlink'):
            self.prepare()


if __name__ == '__main__':
    unittest.main()

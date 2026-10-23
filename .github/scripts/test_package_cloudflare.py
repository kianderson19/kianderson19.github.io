import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('package-cloudflare.py')
spec = importlib.util.spec_from_file_location('cloudflare_package', SCRIPT)
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.write('index.html', '<script src="/assets/main.js"></script><a href="/help">Help</a>')
        self.write('404.html', 'Missing page')
        self.write('help.html', '<a href="/?view=help#intro">Home</a>')
        self.write('_headers', '/*\n  X-Content-Type-Options: nosniff\n')
        self.write('assets/main.js', 'import "./worker.js";')
        self.write('assets/worker.js', 'self.onmessage=()=>{};')
        self.write('data/live-patches.json', b'{"latestDate":"2026-10-20"}\n')
        self.write('data/statistics-snapshot.json', b'{"snapshot":"original bytes"}\n')

    def write(self, name, content):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content.encode() if isinstance(content, str) else content)
        return target

    def test_allowlist_preserves_runtime_bytes_and_excludes_repository_files(self):
        for name in ['.git/config', '.github/secret.json', '.env', 'wrangler.json',
                     'README.md', 'credentials.json', 'assets/main.js.map', 'data/source.ts']:
            self.write(name, 'not public')
        self.write('assets/prior-release.js', 'retained for older tabs')
        self.write('recognition/portrait-v1.bin', b'\x00\xffmodel')
        self.write('ocr/eng.traineddata.gz', b'compressed model')
        self.write('ads.txt', b'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n')
        self.write('app-ads.txt', b'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n')
        self.write('guide-methodology.html', '<h1>Original guide</h1>')
        self.write('_redirects', '/home / 302\n')
        result = p.package(self.root)
        output = self.root / '.cloudflare-dist'
        self.assertEqual(result['files'], len([f for f in output.rglob('*') if f.is_file()]))
        for name in ['data/live-patches.json', 'data/statistics-snapshot.json',
                     'assets/prior-release.js', 'recognition/portrait-v1.bin',
                     'ocr/eng.traineddata.gz', 'ads.txt', 'app-ads.txt', 'guide-methodology.html', '_headers', '_redirects', '404.html']:
            self.assertEqual((output / name).read_bytes(), (self.root / name).read_bytes())
        for name in ['.git', '.github', '.env', 'wrangler.json', 'README.md',
                     'credentials.json', 'assets/main.js.map', 'data/source.ts']:
            self.assertFalse((output / name).exists(), name)

    def test_missing_reference_cannot_replace_previous_package(self):
        self.write('.cloudflare-dist/previous', 'keep')
        self.write('index.html', '<script src="/assets/missing.js"></script>')
        with self.assertRaisesRegex(ValueError, 'Missing public reference'):
            p.package(self.root)
        self.assertEqual((self.root / '.cloudflare-dist/previous').read_text(), 'keep')

    def test_private_looking_file_inside_runtime_directory_is_rejected(self):
        self.write('data/api-token.json', '{}')
        with self.assertRaisesRegex(ValueError, 'Private-looking'):
            p.package(self.root)

    def test_symlinks_are_rejected_without_following_them(self):
        for name in ['assets/excluded.map', 'data/linked.json', 'theme-init.js', '.cloudflare-dist']:
            with self.subTest(name=name):
                target = self.root / name
                target.symlink_to(self.root / 'data/live-patches.json')
                try:
                    with self.assertRaises(ValueError):
                        p.package(self.root)
                finally:
                    target.unlink()

    def test_runtime_directory_symlink_is_rejected(self):
        (self.root / 'icons').symlink_to(self.root / 'data', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            p.package(self.root)

    def test_cloudflare_file_size_and_count_limits_are_enforced(self):
        self.assertEqual(p.MAX_FILES, 20_000)
        self.assertEqual(p.MAX_FILE_BYTES, 25 * 1024 * 1024)
        oversized = self.root / 'assets/oversized.js'
        with oversized.open('wb') as stream:
            stream.seek(p.MAX_FILE_BYTES)
            stream.write(b'x')
        with self.assertRaisesRegex(ValueError, '25 MiB'):
            p.package(self.root)
        oversized.unlink()
        with patch.object(p, 'MAX_FILES', 2):
            with self.assertRaisesRegex(ValueError, 'asset count'):
                p.package(self.root)

    def test_invalid_json_and_missing_required_file_fail_before_replacement(self):
        self.write('.cloudflare-dist/previous', 'keep')
        self.write('data/live-patches.json', '{broken')
        with self.assertRaises(json.JSONDecodeError):
            p.package(self.root)
        self.assertEqual((self.root / '.cloudflare-dist/previous').read_text(), 'keep')
        (self.root / 'data/live-patches.json').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing required'):
            p.package(self.root)

    def test_repeat_package_is_deterministic_and_removes_unallowlisted_stale_output(self):
        first = p.package(self.root)
        self.write('.cloudflare-dist/stale-secret.txt', 'must be removed')
        second = p.package(self.root)
        self.assertEqual(first, second)
        self.assertFalse((self.root / '.cloudflare-dist/stale-secret.txt').exists())
        self.assertEqual((self.root / 'data/live-patches.json').read_bytes(), b'{"latestDate":"2026-10-20"}\n')

    def test_local_html_references_keep_query_views_and_reject_traversal(self):
        self.write('index.html', '<a href="/?view=help">Help</a><a href="/help.html#intro">Guide</a><a href="https://example.com/elsewhere">External</a>')
        p.package(self.root)
        self.write('index.html', '<script src="/%2e%2e/private.js"></script>')
        with self.assertRaisesRegex(ValueError, 'Invalid public reference'):
            p.package(self.root)


class DeploymentConfigurationTests(unittest.TestCase):
    def test_preview_configuration_has_no_compute_or_domain_management(self):
        config = json.loads((SCRIPT.parents[2] / 'wrangler.json').read_text())
        self.assertEqual(config['assets'], {'directory': './.cloudflare-dist', 'not_found_handling': '404-page'})
        self.assertIs(config['workers_dev'], True)
        self.assertIs(config['preview_urls'], False)
        self.assertFalse(set(config) - {'name', 'compatibility_date', 'workers_dev', 'preview_urls', 'assets'})

    def test_fallback_workflow_keeps_credentials_behind_trusted_main_gate(self):
        workflow = (SCRIPT.parents[1] / 'workflows/deploy-cloudflare.yml').read_text()
        guard = workflow.split('    if: >-\n', 1)[1].split('    runs-on:', 1)[0]
        for condition in ["vars.CLOUDFLARE_DEPLOY_ENABLED == 'true'", "github.ref == 'refs/heads/main'",
                          "github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.head_branch == 'main'",
                          'github.event.workflow_run.head_repository.full_name == github.repository']:
            self.assertIn(condition, guard)
        self.assertIn('Refresh official Overwatch patches', workflow)
        self.assertIn('Refresh official Overwatch statistics', workflow)
        self.assertIn('ref: main', workflow)
        self.assertIn('persist-credentials: false', workflow)
        self.assertIn('group: johap-cloudflare-deployment', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('contents: read', workflow)
        self.assertNotIn('write', workflow)
        self.assertEqual(workflow.count('secrets.CLOUDFLARE_API_TOKEN'), 1)
        self.assertEqual(workflow.count('secrets.CLOUDFLARE_ACCOUNT_ID'), 1)
        self.assertNotIn('workflow_run.head_sha', workflow)
        self.assertIn("wranglerVersion: '4.152.0'", workflow)
        for reference in ['actions/checkout@', 'actions/setup-node@', 'cloudflare/wrangler-action@']:
            self.assertRegex(workflow, reference + '[0-9a-f]{40} # v[0-9]+')


if __name__ == '__main__':
    unittest.main()

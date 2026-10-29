"""Stage the published website for Workers Static Assets, without build dependencies."""
import argparse
import hashlib
import json
import os
import posixpath
import re
import shutil
import tempfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

MAX_FILES = 20_000
MAX_FILE_BYTES = 25 * 1024 * 1024
ROOT_FILES = frozenset('''404.html _headers _redirects about.html ads.txt app-ads.txt api-data.css api-data.html
apple-touch-icon.png credits.html guide-methodology.html download.html downloads.json favicon.svg help.html
hero-tiers.html icon-192.png icon-512.png index.html info.css info.js manifest.webmanifest methodology.html og-image.png
practical-compositions.html practical-guide.css privacy.html report-tables.css robots.txt
score-guide.css score-guide.html score-guide.js sitemap.xml sw.js tactical-profiles.css
tactical-profiles.html terms.html theme-init.js'''.split())
REQUIRED_FILES = frozenset({'index.html', '404.html', '_headers',
                            'data/live-patches.json', 'data/statistics-snapshot.json'})
DIRECTORY_EXTENSIONS = {
    # Retain published historical chunks: older open tabs may still lazy-load them.
    'assets': {'.js', '.css'},
    'data': {'.json'}, 'guide': {'.json', '.txt'},
    'icons': {'.png', '.webp'}, 'portraits': {'.png', '.webp'},
    'icons-legacy': {'.png', '.json'}, 'icons-scoreboard': {'.png', '.json'},
    'icons-scoreboard-variants': {'.png', '.json'},
    'maps': {'.jpg', '.jpeg', '.png', '.svg', '.webp'}, 'licenses': {'.txt'},
}
EXACT_DIRECTORY_FILES = {
    'ocr': {'worker.min.js', 'tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm',
            'eng.traineddata.gz', 'kor.traineddata.gz'},
    'recognition': {'portrait-v1.json', 'portrait-v1.bin', 'LICENSE.txt', 'MODEL-CARD.md'},
}
PRIVATE_NAME = re.compile(r'(^|[-_.])(secrets?|credentials?|tokens?|api[-_]?keys?)([-_.]|$)', re.I)


def directory_files(directory):
    """Never follow a link, including a link whose extension would be excluded."""
    if directory.is_symlink():
        raise ValueError(f'Symlink is not publishable: {directory.name}')
    if not directory.is_dir():
        raise ValueError(f'Expected runtime directory: {directory.name}')
    for path in sorted(directory.iterdir()):
        if path.is_symlink():
            raise ValueError(f'Symlink is not publishable: {path}')
        if path.name.startswith('.') or PRIVATE_NAME.search(path.name):
            raise ValueError(f'Private-looking runtime path: {path}')
        if path.is_dir():
            yield from directory_files(path)
        elif path.is_file():
            yield path
        else:
            raise ValueError(f'Unsupported runtime file: {path}')


def select_files(root):
    selected = {}
    for name in sorted(ROOT_FILES):
        path = root / name
        if path.is_symlink():
            raise ValueError(f'Symlink is not publishable: {name}')
        if path.exists():
            if not path.is_file():
                raise ValueError(f'Expected public file: {name}')
            selected[name] = path
    for name in sorted(DIRECTORY_EXTENSIONS.keys() | EXACT_DIRECTORY_FILES.keys()):
        directory = root / name
        if not directory.exists() and not directory.is_symlink():
            continue
        for path in directory_files(directory):
            relative = path.relative_to(root).as_posix()
            allowed = (path.suffix.lower() in DIRECTORY_EXTENSIONS.get(name, set())
                       or path.relative_to(directory).as_posix() in EXACT_DIRECTORY_FILES.get(name, set()))
            if allowed:
                selected[relative] = path
    missing = REQUIRED_FILES - selected.keys()
    if missing:
        raise ValueError(f'Missing required public files: {", ".join(sorted(missing))}')
    if len(selected) > MAX_FILES:
        raise ValueError(f'Static asset count exceeds {MAX_FILES}')
    for relative, path in selected.items():
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError(f'Static asset exceeds 25 MiB: {relative}')
        if path.suffix == '.json':
            json.loads(path.read_bytes())
    return selected


class HtmlReferences(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.references = []

    def handle_starttag(self, tag, attrs):
        self.references.extend(value for key, value in attrs
                               if key in {'src', 'href'} and value)


def validate_html_references(files):
    """Catch omitted entry chunks/pages without guessing dynamic JS dependencies."""
    for relative, path in files.items():
        if path.suffix != '.html':
            continue
        parser = HtmlReferences()
        parser.feed(path.read_text())
        for reference in parser.references:
            url = urlsplit(reference)
            if url.scheme or url.netloc or not url.path:
                continue
            decoded = unquote(url.path)
            target = posixpath.normpath(decoded.lstrip('/') if decoded.startswith('/')
                                        else posixpath.join(posixpath.dirname(relative), decoded))
            if target == '..' or target.startswith('../') or '\\' in target:
                raise ValueError(f'Invalid public reference in {relative}: {reference}')
            if target == '.':
                target = 'index.html'
            candidates = {target}
            if not posixpath.splitext(target)[1]:
                candidates.update({target + '.html', target.rstrip('/') + '/index.html'})
            if not candidates.intersection(files):
                raise ValueError(f'Missing public reference in {relative}: {reference}')


def package(root):
    root = Path(root).resolve(strict=True)
    output = root / '.cloudflare-dist'
    if output.is_symlink() or (output.exists() and not output.is_dir()):
        raise ValueError('Unsafe .cloudflare-dist destination')
    files = select_files(root)
    validate_html_references(files)
    temporary = Path(tempfile.mkdtemp(prefix='.cloudflare-dist-', dir=root))
    hashes = {}
    total_bytes = 0
    try:
        for relative, source in sorted(files.items()):
            content = source.read_bytes()
            if source.is_symlink() or len(content) > MAX_FILE_BYTES:
                raise ValueError(f'Runtime file changed during packaging: {relative}')
            target = temporary / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            hashes[relative] = hashlib.sha256(content).hexdigest()
            total_bytes += len(content)
        # Replace only the dedicated staging directory, after all checks/copies pass.
        if output.exists():
            shutil.rmtree(output)
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return {'directory': '.cloudflare-dist', 'files': len(files), 'bytes': total_bytes,
            'sha256': hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest(),
            'dataSHA256': {name: digest for name, digest in hashes.items() if name.startswith('data/')}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    print(json.dumps(package(args.root), sort_keys=True))


if __name__ == '__main__':
    main()

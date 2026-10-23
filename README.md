# Johap

오버워치 조합 분석·영웅 추천과 Windows 데스크톱 프로토타입 안내입니다.

- 웹사이트: https://johap.lol/
- 이전 주소/병행 운영: https://kianderson19.github.io/
- 다운로드: https://johap.lol/download.html
- Windows 시험 빌드: https://github.com/kianderson19/johap/releases/tag/desktop-v0.1.0
- 사용 방법: https://johap.lol/help.html
- 개인정보처리방침: https://johap.lol/privacy.html

The website runs composition recommendations and screenshot recognition locally in the browser. Screenshots are not sent to Johap servers. Public career queries use OverFast. The desktop preview contains an explicitly labelled demonstration and manual correction controls; a prototype is not a promise of complete in-game telemetry.

Desktop downloads and their SHA-256 hashes are listed at `/download.html`. Native Windows game compatibility needs Windows testing. A labelled web banner space is reserved. AdSense is not enabled, and no advertising approval is claimed. Once a real JOHAP_ADSENSE_CLIENT is supplied, the source build can generate ownership verification metadata and ads.txt. Production ad serving still requires site approval and a verified consent/CSP integration.

Windows ZIP 시작 검사는 수동 실행하는 GitHub Actions에 있습니다. 공개 ZIP의 SHA-256을 확인하고, 기본 보안 설정으로 앱을 시작해 렌더러·IPC의 준비 상태와 10초 유지 여부를 확인합니다. 실제 오버워치, OCR 정확도, DPI, 오버레이 입력 및 전체화면 검증은 별도입니다.

Operator: Johap. Questions and bug reports: https://github.com/kianderson19/johap/issues

This is an independent fan project, not affiliated with Blizzard Entertainment. Game images and trademarks belong to their respective owners. Runtime libraries retain their accompanying licence notices.

## Cloudflare Static Assets

The production deployment uses Workers Static Assets only: no Worker script,
database, KV/R2 binding, paid compute configuration, or domain route is declared.
The existing GitHub Pages site and its daily patch/six-hour statistics workflows stay in place.
The Cloudflare deployment is `johap.haspreorder.workers.dev`; the purchased custom
domain is `johap.lol`. DNS/HTTPS cutover verification is tracked in the private QA record.

GitHub Actions (`deploy-cloudflare.yml`) is the active deployment controller. A reviewed,
account-scoped **Workers Scripts → Edit** token and account ID are stored as encrypted
Actions secrets, and `CLOUDFLARE_DEPLOY_ENABLED=true`. Workers Builds Git integration
is not enabled. Do not enable a second deployment controller for the same Worker.

```text
Build command:  python3 -B .github/scripts/package-cloudflare.py
Deploy command: npx --yes wrangler@4.152.0 deploy --config wrangler.json
Node version:  22 or newer
```

The packaging command uses Python's standard library and requires no source build or
package install. It copies an explicit public-file/directory allowlist into
`.cloudflare-dist`, checks local HTML references, rejects symlinks and private-looking
runtime paths, validates JSON syntax, and enforces 20,000 files/25 MiB per file.
JSON and binary data are copied byte-for-byte. Existing published JS/CSS chunks are
retained so an older open tab can still load its lazy chunks; source maps, repository
metadata, workflow files, configuration and root README are excluded. New public root
files or runtime directory types require an allowlist review.

Run the packaging safeguards locally with:

```sh
python3 -B -m unittest discover -s .github/scripts -p 'test_package_cloudflare.py'
python3 -B .github/scripts/package-cloudflare.py
```

Store `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` only as Actions secrets.
Scope the token to **Workers Scripts → Edit** on the specific account; this asset-only
configuration does not manage zone/DNS routing. Never commit tokens or add them to
the static asset directory. To pause deployment, set `CLOUDFLARE_DEPLOY_ENABLED=false`.

The workflow deploys the current `main` tip after a main-branch push, manual run, or
successful same-repository/main scheduled or manual patch/statistics refresh. This
also covers data commits made with `GITHUB_TOKEN`, which do not trigger another
Actions push workflow. Deployments are serialized and do not consume artifacts from
the triggering run. Existing refresh schedules and their GitHub Pages publication
are unchanged. The first manual Actions deployment succeeded on 2026-10-23;
the next scheduled data-refresh-triggered deployment remains a separate operational check.

After the domain is purchased and its Cloudflare zone is active, attach the domain
through the Worker dashboard, verify it, then set `workers_dev` to `false` if the
temporary address should be disabled. Keep both `route` and `routes` absent when
domain attachment is managed in the dashboard. Query-based views continue to use `/`;
unknown paths use the existing `404.html`. Default HTML canonical redirects and all
help/download/legal pages should be checked on the preview before domain cutover.

Official references: [Static Assets](https://developers.cloudflare.com/workers/static-assets/),
[limits](https://developers.cloudflare.com/workers/platform/limits/),
[GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/),
[custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
[routing source of truth](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth).
Action commit pins and Wrangler 4.152.0 were checked against their official release
metadata on 2026-10-23; update pins only after reviewing and testing the replacement.

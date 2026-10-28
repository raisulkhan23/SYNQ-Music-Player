# Publishing a SYNQ release

This repository is a **public release** of SYNQ, not a mirror of the development
project. Development happens in a private checkout; releases are selective,
reviewed copies of it. The two histories are never connected — nothing is pushed
from the development repository to this one, and `.git` is never copied between
them.

## Ground rules

1. **Never copy `.git`.** A release commit is made here, from files. Importing
   development history would also import every credential that ever touched the
   repository.
2. **Allowlist, not blocklist.** Only the paths listed in
   `tools/release-paths.txt` are copied. New top-level directories are published
   only by adding them to that list on purpose.
3. **Never copy the files this repository owns.** `README.md`, `.env.example`,
   `.gitignore` and `docs/` are maintained here, because their public wording
   differs from the development versions.
4. **Review the diff before staging, and the staged list before committing.**
   The workflow below prints both and stops in between.
5. **Never publish secrets.** Before committing, the checks below refuse to
   proceed if a `.env`, keystore, `local.properties` or key file appears in the
   change set.
6. **No automatic sync.** Publishing is a deliberate act with a review step in
   the middle.

## Steps

The checkout locations are examples; use your own paths.

```bash
# 0. Development checkout: know what you are releasing.
cd D:/synqmusic/synqmusic
git status --short          # uncommitted work is released too — decide if that
                            # is what you want, since the copy reads the worktree

# 1. Copy the allowlisted paths into the release checkout. Dry run first: this
#    prints every file that would change and touches nothing.
cd D:/synqmusic/SYNQ-Public-Release
node tools/sync-from-dev.mjs --source D:/synqmusic/synqmusic
node tools/sync-from-dev.mjs --source D:/synqmusic/synqmusic --apply

# 2. Review. `git status` is the whole change set; `git diff` is the actual code.
git status --short
git diff

# 3. Run the checks against the release contents. Refuses on failure.
node tools/sync-from-dev.mjs --checks

# 4. Publish. Stages only the allowlist, refuses on a secret-looking path,
#    and needs the confirmation flag because it commits and pushes.
node tools/sync-from-dev.mjs --publish --message "Release 1.1: artist catalogues" --confirm-publish
```

By hand, the same sequence is:

```bash
rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' \
  --include-from=<(printf '%s\n' src public electron android tests scripts \
    index.html main.ts package.json package-lock.json CHANGELOG.md \
    vite.config.ts vitest.config.ts tsconfig*.json eslint.config.js \
    postcss.config.cjs components.json convex.json capacitor.config.ts \
    electron-builder.yml .prettierrc .prettierignore .gitattributes) \
  D:/synqmusic/synqmusic/ ./
npm ci && npm run build && npm run lint && npx vitest run
git add <explicit files> && git commit && git push origin main
```

## What must never be published

| Path | Why |
| --- | --- |
| `.env`, `.env.local`, `.env.keys`, `.env.production` | Real values; `.env.keys` decrypts `.env.local` |
| `android/keystore.properties`, `android/keystores/` | Release signing password and keystore |
| `android/local.properties` | Machine-specific SDK path |
| `node_modules/`, `dist/`, `desktop-dist/`, `build/`, `all-installers/` | Generated or machine-specific |
| `.freebuff/`, `.baseline-build/`, `brag-output/`, `notes/`, `*.log` | Development state and scratch work |
| `assets/readme`, personal scripts with absolute home paths | Not needed to build |

When a file is excluded, ask whether the app still builds without it. A
directory is never excluded wholesale just because it looks internal; `src`,
`tests`, `scripts` and `android` are all part of the product.

## What is sanitised in the copy

The release is not byte-identical to the development tree. On purpose:

- **Deployment hosts.** `src/convex/auth.ts` lists trusted origins for *this*
  deployment in the private tree; the public copy documents where to add your
  own instead, so a self-hosted deployment cannot accidentally accept, or
  publish, someone else's.
- **Internal QA harnesses.** Deployment-specific audit scripts and scratch
  probes under `scripts/` are not published.
- **README and `.env.example`.** Rewritten for people who do not have this
  development checkout.

If you re-introduce a private hostname in the source, these are the files to
re-check before the next release:

```bash
grep -rnE 'convex\.(cloud|site)' src scripts | grep -v 'your-deployment'
grep -rnE '/Users/|C:\\Users' --include='*.ts' --include='*.tsx' --include='*.mjs' .
```

## Recording a release

Each published commit is the record:

```bash
git log --oneline --decorate -5
git tag -a release-$(date +%Y.%m.%d) -m "Public release"
```

The tooling also appends the pushed commit SHA to `.release-log` in the release
checkout (gitignored), so the sequence of published commits survives locally
even after branches move.

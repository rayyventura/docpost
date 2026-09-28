# Deployed end-to-end test

`deployed-send.e2e.test.mjs` exercises a deployed DocPost environment through its public API, the same way the web app does:

1. Logs in with `POST /auth/login`.
2. Finds two destination folders by browsing `/destinations/teams` → binders → binder contents.
3. Submits one job (`POST /jobs`) that sends three files to both folders. The request includes each file's size and SHA-256.
4. Uploads each file to the presigned upload plan it gets back (single PUT, or multipart for files over 100 MB).
5. Polls `GET /jobs/:id` with backoff until the job finishes. It then checks that all 6 tasks (3 files × 2 folders) are `completed`. Any task that isn't shows up with its `failureReason`.
6. Lists each folder with `GET /destinations/folders/:id/contents` and checks that each delivered document is there by name and size.
7. Downloads one delivered document with `GET /destinations/documents/:id/download` and checks that its SHA-256 matches the local file. The download can come back as a `{url, expiresIn}` presigned URL or as streamed bytes, and the test handles both. It also tries `POST /files/:fileId/download-url` but doesn't require it to work.

The test creates a real job and real documents in the target environment. It doesn't delete anything.

## Run

Use Node 22 or newer. You don't need to install any packages.

```sh
E2E_EMAIL=alice@example.com E2E_PASSWORD='<password>' node --test 'e2e/*.test.mjs'
```

On Node 22, `node --test e2e/` also works. On Node 23 and newer, a bare directory argument is treated as a module path and fails, so use the glob shown above.

The dev database is seeded by `services/auth/src/db/seed.ts`, so you can use one of those dev-only users.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `E2E_API_BASE` | `https://sqkzppgzuf.execute-api.us-east-1.amazonaws.com` (dev, SSM `/docpost/dev/api_base`) | DocPost API base URL |
| `E2E_EMAIL` / `E2E_PASSWORD` | required | Login credentials |
| `E2E_FOLDER_IDS` | discovered | Two or more `teamId:binderId:folderId` entries, comma-separated. The job API needs all three IDs. |
| `E2E_FILES` | `~/Desktop/docpost-test-pdfs/test-doc-019.pdf`, `-020`, `-021`, or generated (see below) | Comma-separated absolute file paths |
| `E2E_GENERATE_FILES` | unset | Set to `1` to use generated PDFs even when the Desktop files exist. `E2E_FILES` still takes precedence. |
| `E2E_TIMEOUT_MS` | `300000` | How long to wait for the job to finish |

## Test files

The test picks its files in this order:

1. `E2E_FILES`, if it's set and not empty.
2. The three Desktop PDFs (`~/Desktop/docpost-test-pdfs/test-doc-019.pdf`, `-020`, `-021`), if all three exist and `E2E_GENERATE_FILES` isn't `1`.
3. Otherwise, three small one-page PDFs generated in a new temp directory (`$TMPDIR/docpost-e2e-*`) at runtime, named `test-doc-019.pdf`, `test-doc-020.pdf` and `test-doc-021.pdf`. Each has different text, including the run's timestamp, so their SHA-256 values differ from each other and from earlier runs.

This is how the test runs in CI, where the Desktop files don't exist. To try the generated mode locally:

```sh
E2E_GENERATE_FILES=1 E2E_EMAIL=alice@example.com E2E_PASSWORD='<password>' node --test 'e2e/*.test.mjs'
```

## GitHub Actions

`.github/workflows/e2e.yml` runs this test against dev on `ubuntu-latest` with Node 22. It runs only when you start it by hand (**Actions → E2E (dev) → Run workflow**), because every run creates a real job and real documents in dev. It has one optional input, `timeout_ms`, which sets `E2E_TIMEOUT_MS`. It doesn't run `npm ci`, and it uses generated PDFs.

Set these in the repository settings:

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `E2E_EMAIL` | secret | yes | Login email for a dev user |
| `E2E_PASSWORD` | secret | yes | That user's password |
| `AWS_DEPLOY_ROLE_ARN` | secret | one of these two | The existing deploy role. When it's set, the workflow assumes it through OIDC, the same way `deploy-auth.yml` does, and reads the API base from SSM `/docpost/dev/api_base`. |
| `E2E_API_BASE` | variable | one of these two | API base URL, used only when `AWS_DEPLOY_ROLE_ARN` isn't set |
| `E2E_FOLDER_IDS` | variable | no | Pins the destination folders. Without it, the test discovers folders. |

If `E2E_EMAIL` or `E2E_PASSWORD` is missing, or there's no way to find the API base, the workflow skips the test and shows a warning instead of failing. It also skips with a warning when the SSM parameter doesn't exist, which means dev is down.

The test never logs tokens or presigned URLs.

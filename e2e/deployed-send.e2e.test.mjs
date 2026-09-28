// End-to-end test against a DEPLOYED DocPost environment (dev by default).
// Logs in, picks two destination folders, submits one job (3 files x 2 folders),
// uploads the files to the presigned plans, waits for delivery, checks the
// documents landed in both folders, and downloads one to compare its SHA-256.
//
// Run: E2E_EMAIL=... E2E_PASSWORD=... node --test 'e2e/*.test.mjs'
// See e2e/README.md for all environment variables.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';

const API_BASE = (process.env.E2E_API_BASE ?? 'https://sqkzppgzuf.execute-api.us-east-1.amazonaws.com').replace(/\/+$/, '');
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const TIMEOUT_MS = Number.parseInt(process.env.E2E_TIMEOUT_MS ?? '300000', 10);
const DEFAULT_FILES = [
  '/Users/rayyventura/Desktop/docpost-test-pdfs/test-doc-019.pdf',
  '/Users/rayyventura/Desktop/docpost-test-pdfs/test-doc-020.pdf',
  '/Users/rayyventura/Desktop/docpost-test-pdfs/test-doc-021.pdf',
];
// E2E_FILES wins. Otherwise use the Desktop test PDFs if they are all there, and
// generate three small PDFs in a temp dir when they aren't (CI) or when
// E2E_GENERATE_FILES=1 forces it.
const FILES_OVERRIDE = process.env.E2E_FILES
  ? process.env.E2E_FILES.split(',').map((p) => p.trim()).filter(Boolean)
  : null;
const GENERATE_FILES = !FILES_OVERRIDE
  && (process.env.E2E_GENERATE_FILES === '1' || !DEFAULT_FILES.every((p) => existsSync(p)));

// A minimal valid one-page PDF with the given text. The xref offsets are computed,
// so the file opens in any viewer. Different text gives a different SHA-256.
function buildPdf(text) {
  const escaped = text.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function generateFiles() {
  const dir = await mkdtemp(join(tmpdir(), 'docpost-e2e-'));
  const runId = new Date().toISOString();
  const paths = [];
  for (const n of ['019', '020', '021']) {
    const path = join(dir, `test-doc-${n}.pdf`);
    await writeFile(path, buildPdf(`DocPost e2e test document ${n} - generated ${runId}`));
    paths.push(path);
  }
  return paths;
}

// Same extension mapping as web/src/jobs/FilePicker.tsx.
const TYPE_BY_EXT = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

const started = Date.now();
function log(message) {
  const secs = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
  console.log(`[e2e +${secs}s] ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

let accessToken = '';

// Calls the DocPost API like web/src/api/client.ts. Never logs the token.
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return response;
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = data?.error?.message ?? (typeof data === 'string' ? data.slice(0, 300) : 'Request failed');
    throw new Error(`${method} ${path} -> HTTP ${response.status}: ${message}`);
  }
  return data;
}

// Browse teams -> binders -> folders one level at a time, as the destination tree does.
async function discoverFolders(count) {
  const found = [];
  const teams = await api('/destinations/teams');
  assert.ok(Array.isArray(teams), 'GET /destinations/teams should return an array');
  for (const team of teams) {
    const binders = await api(`/destinations/teams/${team.id}/binders`);
    for (const binder of binders ?? []) {
      const contents = await api(`/destinations/binders/${binder.id}/contents`);
      for (const folder of contents?.folders ?? []) {
        found.push({
          teamId: team.id,
          binderId: binder.id,
          folderId: folder.id,
          label: `${team.name} / ${binder.name} / ${folder.name}`,
        });
        if (found.length >= count) return found;
      }
    }
  }
  return found;
}

function parseFolderOverride(value) {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const parts = entry.split(':');
    assert.equal(
      parts.length,
      3,
      `E2E_FOLDER_IDS entries must be teamId:binderId:folderId (got "${entry}")`,
    );
    const [teamId, binderId, folderId] = parts;
    return { teamId, binderId, folderId, label: `folder ${folderId}` };
  });
}

async function uploadSingle(plan, file) {
  const response = await fetch(plan.presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.contentType },
    body: file.bytes,
  });
  if (!response.ok) {
    throw new Error(`Upload of ${file.name} failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
}

async function uploadMultipart(plan, file) {
  const partSize = plan.partSize ?? 16 * 1024 * 1024;
  const initiated = await api(`/files/${plan.fileId}/multipart`, { method: 'POST' });
  const completed = [];
  for (const part of initiated.parts) {
    const start = (part.partNumber - 1) * partSize;
    const end = Math.min(start + partSize, file.bytes.length);
    const response = await fetch(part.url, { method: 'PUT', body: file.bytes.subarray(start, end) });
    if (!response.ok) throw new Error(`Part ${part.partNumber} of ${file.name} failed: HTTP ${response.status}`);
    const etag = response.headers.get('etag');
    if (!etag) throw new Error(`Part ${part.partNumber} of ${file.name} returned no ETag`);
    completed.push({ partNumber: part.partNumber, etag });
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${completed
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
    .join('')}</CompleteMultipartUpload>`;
  const response = await fetch(initiated.completeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
  });
  if (!response.ok) throw new Error(`Completing multipart upload of ${file.name} failed: HTTP ${response.status}`);
}

// Handles both download shapes: JSON {url, expiresIn} (presigned) or streamed bytes.
async function downloadBytes(path, method = 'GET') {
  const response = await api(path, { method, raw: true });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = await response.json();
    assert.ok(body && typeof body.url === 'string', `${path} returned JSON without a url`);
    const fileResponse = await fetch(body.url);
    assert.ok(fileResponse.ok, `Fetching presigned download URL failed: HTTP ${fileResponse.status}`);
    return { shape: 'presigned-url', bytes: Buffer.from(await fileResponse.arrayBuffer()) };
  }
  return { shape: 'streamed-bytes', bytes: Buffer.from(await response.arrayBuffer()) };
}

test('deployed DocPost: send 3 files to 2 folders, deliver, and download', { timeout: TIMEOUT_MS + 180_000 }, async () => {
  assert.ok(EMAIL && PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD');
  const FILE_PATHS = FILES_OVERRIDE ?? (GENERATE_FILES ? await generateFiles() : DEFAULT_FILES);
  assert.ok(FILE_PATHS.length > 0, 'No files to send');
  if (GENERATE_FILES) log(`generated test PDFs in ${dirname(FILE_PATHS[0])}`);
  log(`API base ${API_BASE}`);

  // 1. Log in.
  const session = await api('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  assert.ok(session?.accessToken, 'POST /auth/login did not return an accessToken');
  accessToken = session.accessToken;
  log(`logged in as ${EMAIL}`);

  // 2. Choose two destination folders.
  const destinations = process.env.E2E_FOLDER_IDS
    ? parseFolderOverride(process.env.E2E_FOLDER_IDS)
    : await discoverFolders(2);
  assert.ok(
    destinations.length >= 2,
    `Need at least two destination folders the user can send to; found ${destinations.length}`,
  );
  const folders = destinations.slice(0, 2);
  assert.notEqual(folders[0].folderId, folders[1].folderId, 'The two destination folders must be distinct');
  for (const f of folders) log(`destination: ${f.label}`);

  // 3. Read files and compute sizes + SHA-256 (the SPA hashes the full file, hex-encoded).
  const localFiles = [];
  for (const path of FILE_PATHS) {
    const bytes = await readFile(path);
    const name = basename(path);
    const contentType = TYPE_BY_EXT[extname(name).slice(1).toLowerCase()];
    assert.ok(contentType, `Unsupported file type: ${name}`);
    localFiles.push({ path, name, bytes, contentType, sizeBytes: bytes.length, sha256: sha256(bytes) });
  }
  log(`files: ${localFiles.map((f) => `${f.name} (${f.sizeBytes} B)`).join(', ')}`);

  const expectedTasks = localFiles.length * folders.length;
  const submitted = await api('/jobs', {
    method: 'POST',
    body: {
      files: localFiles.map(({ name, sizeBytes, contentType, sha256: hash }) => ({ name, sizeBytes, contentType, sha256: hash })),
      destinations: folders.map(({ teamId, binderId, folderId }) => ({ teamId, binderId, folderId })),
    },
  });
  const jobId = submitted.jobId;
  assert.ok(jobId, 'POST /jobs did not return a jobId');
  assert.equal(submitted.taskCount, expectedTasks, 'POST /jobs taskCount');
  assert.equal(submitted.uploads?.length, localFiles.length, 'POST /jobs should return one upload plan per file');
  log(`job ${jobId} created, taskCount=${submitted.taskCount}`);

  // 4. Upload each file to its plan (plans are returned in file order, as NewJobPage assumes).
  const uploadStart = Date.now();
  await Promise.all(submitted.uploads.map(async (plan, i) => {
    const file = localFiles[i];
    file.serverFileId = plan.fileId;
    if (plan.multipart) {
      await uploadMultipart(plan, file);
    } else {
      assert.ok(plan.presignedUrl, `Upload plan for ${file.name} has no presignedUrl`);
      await uploadSingle(plan, file);
    }
  }));
  log(`uploaded ${localFiles.length} files in ${Date.now() - uploadStart} ms`);

  // 5. Poll the job until it is terminal.
  const pollStart = Date.now();
  let delay = 1000;
  let job;
  let lastSummary = '';
  for (;;) {
    job = await api(`/jobs/${jobId}`);
    const c = job.counts ?? {};
    const summary = `status=${job.aggregateStatus} pending=${c.pending} in_progress=${c.in_progress} completed=${c.completed} failed=${c.failed}`;
    if (summary !== lastSummary) {
      log(`job ${jobId}: ${summary}`);
      lastSummary = summary;
    }
    if ((c.pending ?? 0) + (c.in_progress ?? 0) === 0) break;
    if (Date.now() - pollStart > TIMEOUT_MS) {
      assert.fail(`Job ${jobId} not terminal after ${TIMEOUT_MS} ms (${summary})`);
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 10_000);
  }
  log(`job ${jobId} terminal after ${((Date.now() - pollStart) / 1000).toFixed(1)} s`);

  const { tasks } = await api(`/jobs/${jobId}/tasks?limit=100`);
  assert.equal(tasks.length, expectedTasks, `Expected ${expectedTasks} tasks`);
  const notCompleted = tasks.filter((t) => t.status !== 'completed');
  assert.equal(
    notCompleted.length,
    0,
    `Tasks not completed:\n${notCompleted
      .map((t) => `  ${t.fileName} -> ${t.destination ?? t.folderId}: ${t.status} (attempts=${t.attemptCount}) ${t.failureReason ?? ''}`)
      .join('\n')}`,
  );
  assert.equal(job.aggregateStatus, 'completed');
  assert.equal(job.counts.completed, expectedTasks);
  log(`all ${tasks.length}/${expectedTasks} tasks completed`);

  // 6. Each destination folder must now contain the three delivered documents.
  let deliveries = 0;
  for (const folder of folders) {
    const contents = await api(`/destinations/folders/${folder.folderId}/contents`);
    const docsById = new Map((contents.documents ?? []).map((d) => [d.id, d]));
    for (const file of localFiles) {
      const task = tasks.find((t) => t.fileId === file.serverFileId && t.folderId === folder.folderId);
      assert.ok(task, `No task for ${file.name} -> ${folder.label}`);
      assert.ok(task.platformDocumentId, `Task for ${file.name} -> ${folder.label} has no platformDocumentId`);
      const doc = docsById.get(task.platformDocumentId);
      assert.ok(doc, `Delivered document ${task.platformDocumentId} (${file.name}) not listed in ${folder.label}`);
      assert.equal(doc.name, file.name, `Delivered document name in ${folder.label}`);
      assert.equal(Number(doc.sizeBytes), file.sizeBytes, `Delivered size of ${file.name} in ${folder.label}`);
      deliveries += 1;
    }
  }
  assert.equal(deliveries, expectedTasks);
  log(`verified ${deliveries} deliveries across ${folders.length} folders`);

  // 7. Download one delivered document and compare its checksum.
  const sample = localFiles[0];
  const sampleTask = tasks.find((t) => t.fileId === sample.serverFileId);
  const delivered = await downloadBytes(`/destinations/documents/${sampleTask.platformDocumentId}/download`);
  const deliveredHash = sha256(delivered.bytes);
  log(`downloaded delivered ${sample.name} (${delivered.bytes.length} B, ${delivered.shape}) sha256 ${deliveredHash.slice(0, 16)}...`);
  assert.equal(deliveredHash, sample.sha256, `SHA-256 of downloaded ${sample.name} does not match the local file`);
  log(`checksum match for delivered ${sample.name}`);

  // Also exercise the staged-file download URL; report but do not require it.
  try {
    const staged = await downloadBytes(`/files/${sample.serverFileId}/download-url`, 'POST');
    const stagedHash = sha256(staged.bytes);
    assert.equal(stagedHash, sample.sha256, `SHA-256 of staged ${sample.name} does not match the local file`);
    log(`checksum match for staged ${sample.name} (${staged.shape})`);
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    log(`staged download not available: ${err.message}`);
  }
});

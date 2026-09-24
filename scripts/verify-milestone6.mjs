const API = process.env.API_BASE_URL ?? 'http://localhost:3003';
const AUTH = process.env.AUTH_BASE_URL ?? 'http://localhost:3001';

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

async function login(email) {
  const res = await fetch(`${AUTH}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status}`);
  const body = await res.json();
  return body.accessToken;
}

async function timed(path, token) {
  const started = performance.now();
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const ms = Math.round(performance.now() - started);
  return { res, ms };
}

async function main() {
  const jobs = await fetch(`${API}/jobs`);
  record('unauthenticated job list returns 401', jobs.status === 401, String(jobs.status));

  const destinations = await fetch(`${API}/destinations/teams`);
  record('unauthenticated destination list returns 401', destinations.status === 401, String(destinations.status));

  const download = await fetch(`${API}/files/00000000-0000-0000-0000-000000000099/download-url`, { method: 'POST' });
  record('unauthenticated download returns 401', download.status === 401, String(download.status));

  const alice = await login('alice@example.com');
  const aliceJobs = await fetch(`${API}/jobs`, { headers: { Authorization: `Bearer ${alice}` } });
  const { jobs: ownedJobs } = await aliceJobs.json();
  const teams = await timed('/destinations/teams', alice);
  record('browse teams under 500ms', teams.res.ok && teams.ms < 500, `${teams.ms}ms`);
  const teamList = await teams.res.json();
  if (teamList.length > 0) {
    const binders = await timed(`/destinations/teams/${teamList[0].id}/binders`, alice);
    record('browse binders under 500ms', binders.res.ok && binders.ms < 500, `${binders.ms}ms`);
  } else {
    record('browse binders under 500ms', false, 'alice has no teams');
  }

  const carol = await login('carol@example.com');
  if (ownedJobs.length === 0) {
    record('outside team job read returns 404', false, 'alice has no jobs to check');
    record('outside team download returns 404', false, 'alice has no jobs to check');
  } else {
    const foreignJob = await fetch(`${API}/jobs/${ownedJobs[0].jobId}`, {
      headers: { Authorization: `Bearer ${carol}` },
    });
    record('outside team job read returns 404', foreignJob.status === 404, String(foreignJob.status));

    const taskRes = await fetch(`${API}/jobs/${ownedJobs[0].jobId}/tasks?limit=1`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    const taskBody = await taskRes.json();
    const fileId = taskBody.tasks?.[0]?.fileId;
    if (!fileId) {
      record('outside team download returns 404', false, 'job has no tasks');
    } else {
      const foreignDownload = await fetch(`${API}/files/${fileId}/download-url`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${carol}` },
      });
      record('outside team download returns 404', foreignDownload.status === 404, String(foreignDownload.status));
    }
  }

  const failed = results.filter((item) => !item.ok);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

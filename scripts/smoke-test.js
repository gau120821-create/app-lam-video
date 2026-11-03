'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = 43000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-studio-smoke-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Server did not start.\n${serverLog}`);
}

function client() {
  let cookie = '';
  let csrf = '';
  return {
    setSession(payload) {
      if (payload.csrf) csrf = payload.csrf;
    },
    async request(pathname, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (cookie) headers.Cookie = cookie;
      if (csrf && options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrf;
      let body = options.body;
      if (body && !(body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
      }
      const response = await fetch(`${base}${pathname}`, { ...options, headers, body, redirect: 'manual' });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const type = response.headers.get('content-type') || '';
      const payload = type.includes('application/json') ? await response.json() : await response.text();
      if (payload && payload.csrf) csrf = payload.csrf;
      return { response, payload };
    },
    async raw(pathname, headers = {}) {
      return fetch(`${base}${pathname}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
    }
  };
}

async function expectOk(resultPromise, label) {
  const { response, payload } = await resultPromise;
  assert(response.ok && payload.ok !== false, `${label}: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function run() {
  await waitForServer();
  const admin = client();
  const bootstrap = await expectOk(admin.request('/api/bootstrap'), 'bootstrap');
  assert(bootstrap.needsSetup === true, 'First run should require setup');

  const setup = await expectOk(admin.request('/api/setup', {
    method: 'POST',
    body: { name: 'Chủ shop', email: 'admin@example.com', password: 'admin-password-123' }
  }), 'setup admin');
  assert(setup.user.role === 'admin', 'Setup user must be admin');

  const staffPayload = await expectOk(admin.request('/api/admin/users', {
    method: 'POST',
    body: { name: 'Nhân viên A', email: 'staff@example.com', password: 'staff-password-123', role: 'staff' }
  }), 'create staff');
  const viewerPayload = await expectOk(admin.request('/api/admin/users', {
    method: 'POST',
    body: { name: 'Người xem', email: 'viewer@example.com', password: 'viewer-password-123', role: 'viewer' }
  }), 'create viewer');
  assert(staffPayload.user.id !== viewerPayload.user.id, 'Users must be distinct');

  const staff = client();
  await expectOk(staff.request('/api/login', {
    method: 'POST',
    body: { email: 'staff@example.com', password: 'staff-password-123' }
  }), 'staff login');

  const projectPayload = await expectOk(staff.request('/api/projects', {
    method: 'POST',
    body: { title: 'Dự án riêng của nhân viên A', sourceMode: 'image', format: '16:9', targetDurationSec: 30, voiceId: 'lily' }
  }), 'staff create project');
  const projectId = projectPayload.project.id;

  const scenePayload = await expectOk(staff.request(`/api/projects/${projectId}/scenes`, {
    method: 'POST',
    body: { title: 'Cảnh mở đầu', durationSec: 6, prompt: 'Product hero', voiceover: 'Câu thoại ban đầu.' }
  }), 'staff create scene');
  const sceneId = scenePayload.scene.id;

  const clipForm = new FormData();
  clipForm.append('file', new Blob(['FAKEMP4DATA-0123456789'], { type: 'video/mp4' }), 'scene.mp4');
  const clipPayload = await expectOk(staff.request(`/api/projects/${projectId}/assets?kind=scene_clip&sceneId=${sceneId}`, {
    method: 'POST',
    body: clipForm
  }), 'staff upload scene clip');
  assert(clipPayload.asset.size_bytes > 10, 'Uploaded clip should be stored');

  const reviewPayload = await expectOk(staff.request(`/api/scenes/${sceneId}/review`, {
    method: 'POST',
    body: { status: 'approved', revisionNote: '' }
  }), 'staff approve scene');
  assert(reviewPayload.scene.review_status === 'approved', 'Scene should be approved');

  const audioForm = new FormData();
  audioForm.append('file', new Blob(['FAKEMP3DATA'], { type: 'audio/mpeg' }), 'voice.mp3');
  await expectOk(staff.request(`/api/projects/${projectId}/assets?kind=audio&sceneId=${sceneId}`, {
    method: 'POST',
    body: audioForm
  }), 'staff upload recorded voice');

  const changedVoice = await expectOk(staff.request(`/api/scenes/${sceneId}`, {
    method: 'PATCH',
    body: { voiceover: 'Câu thoại mới.' }
  }), 'staff edit voiceover');
  assert(changedVoice.voiceoverChanged === true, 'Voiceover edit should be detected');
  assert(changedVoice.scene.audio_asset_id === null, 'Editing voiceover should discard old recording');
  assert(changedVoice.scene.voice_sync_status === 'not_recorded', 'Edited scene should need re-recording');

  const viewer = client();
  await expectOk(viewer.request('/api/login', {
    method: 'POST',
    body: { email: 'viewer@example.com', password: 'viewer-password-123' }
  }), 'viewer login');
  const forbiddenProject = await viewer.request(`/api/projects/${projectId}`);
  assert(forbiddenProject.response.status === 404, 'Another employee must not access a private workspace project');
  const forbiddenCreate = await viewer.request('/api/projects', {
    method: 'POST',
    body: { title: 'Không được phép' }
  });
  assert(forbiddenCreate.response.status === 403, 'Viewer role must not create projects');

  const adminProjects = await expectOk(admin.request('/api/projects'), 'admin list all projects');
  assert(adminProjects.projects.some((project) => project.id === projectId), 'Admin should see staff project');

  const finalForm = new FormData();
  finalForm.append('file', new Blob(['0123456789ABCDEFGHIJ'], { type: 'video/mp4' }), 'final.mp4');
  const finalPayload = await expectOk(staff.request(`/api/projects/${projectId}/assets?kind=final_video`, {
    method: 'POST',
    body: finalForm
  }), 'staff upload final video');
  const rangeResponse = await staff.raw(`/api/assets/${finalPayload.asset.id}/content`, { Range: 'bytes=2-5' });
  assert(rangeResponse.status === 206, `Range playback should return 206, got ${rangeResponse.status}`);
  assert((await rangeResponse.text()) === '2345', 'Range response should return the requested bytes');

  console.log('Smoke test passed: setup, roles, private workspaces, admin visibility, uploads, review gate, voiceover invalidation, and Range playback.');
}

run()
  .catch((error) => {
    console.error(error.stack || error.message);
    console.error(serverLog);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill('SIGTERM');
    setTimeout(() => {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }, 100);
  });

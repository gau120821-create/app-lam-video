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
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, WORKER_TOKEN: 'test-worker-token' },
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

  // --- Parity features: storyboard parsing ---
  const storyboard = [
    'Cảnh 1 (6s): Chai sản phẩm hiện ra trong sương nước.',
    'Lời thoại: Da đầu bong tróc cần chăm sóc đúng cách.',
    'Chữ: DÀNH CHO DA ĐẦU BONG TRÓC',
    '',
    'Cảnh 2 (8s): Chai đứng trên bệ trắng trong spa.',
    'Lời thoại: Giới thiệu sản phẩm mới.'
  ].join('\n');
  const parsedPayload = await expectOk(staff.request('/api/projects/parse-storyboard', {
    method: 'POST',
    body: { title: 'Dự án từ kịch bản', format: '16:9', voiceId: 'lily', storyboardText: storyboard }
  }), 'parse storyboard');
  assert(parsedPayload.sceneCount === 2, `Storyboard should produce 2 scenes, got ${parsedPayload.sceneCount}`);
  const parsedDetail = await expectOk(staff.request(`/api/projects/${parsedPayload.project.id}`), 'get parsed project');
  assert(Number(parsedDetail.scenes[0].duration_sec) === 6, 'Scene 1 duration should parse as 6s');
  assert(Number(parsedDetail.scenes[1].duration_sec) === 8, 'Scene 2 duration should parse as 8s');
  assert(parsedDetail.scenes[0].voiceover.includes('Da đầu bong tróc'), 'Scene 1 voiceover should be parsed');
  assert(parsedDetail.scenes[0].overlay.includes('BONG TRÓC'), 'Scene 1 overlay should be parsed');

  // --- Parity features: scale durations ---
  const scaled = await expectOk(staff.request(`/api/projects/${parsedPayload.project.id}/scale-durations`, {
    method: 'POST',
    body: { targetDurationSec: 28 }
  }), 'scale durations');
  const scaledSum = scaled.durations.reduce((a, b) => a + b, 0);
  assert(Math.abs(scaledSum - 28) < 0.01, `Scaled durations should sum to 28, got ${scaledSum}`);

  // --- Parity features: move scene ---
  const secondSceneId = parsedDetail.scenes[1].id;
  await expectOk(staff.request(`/api/projects/${parsedPayload.project.id}/move-scene`, {
    method: 'POST',
    body: { sceneId: secondSceneId, direction: 'up' }
  }), 'move scene up');
  const movedDetail = await expectOk(staff.request(`/api/projects/${parsedPayload.project.id}`), 'get moved project');
  assert(movedDetail.scenes[0].id === secondSceneId, 'Scene 2 should now be first after moving up');

  // --- Parity features: exact reference image from source photo ---
  const sourceForm = new FormData();
  sourceForm.append('file', new Blob(['FAKEJPEGDATA'], { type: 'image/jpeg' }), 'sample.jpg');
  await expectOk(staff.request(`/api/projects/${projectId}/assets?kind=source_image`, {
    method: 'POST',
    body: sourceForm
  }), 'staff upload source image');
  const exactRef = await expectOk(staff.request(`/api/scenes/${sceneId}/reference`, {
    method: 'POST',
    body: { mode: 'exact' }
  }), 'exact reference');
  assert(exactRef.exact === true, 'Exact reference should be flagged exact');
  const refDetail = await expectOk(staff.request(`/api/projects/${projectId}`), 'get project after exact reference');
  const refScene = refDetail.scenes.find((scene) => scene.id === sceneId);
  assert(refScene.ref_exact === 1 && refScene.ref_asset_id === exactRef.asset.id, 'Scene should carry the exact reference');

  // --- Parity features: music library + project assignment ---
  const musicForm = new FormData();
  musicForm.append('file', new Blob(['FAKEMP3MUSIC'], { type: 'audio/mpeg' }), 'engage.mp3');
  const musicPayload = await expectOk(staff.request('/api/music-assets/upload', {
    method: 'POST',
    body: musicForm
  }), 'upload music');
  const musicPatch = await expectOk(staff.request(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: { musicAssetId: musicPayload.asset.id }
  }), 'assign music to project');
  assert(musicPatch.project.music_asset_id === musicPayload.asset.id, 'Project should reference the music asset');

  // --- Parity features: real FFmpeg stitch of uploaded clips ---
  const { execFileSync } = require('node:child_process');
  const stitchProject = await expectOk(staff.request('/api/projects', {
    method: 'POST',
    body: { title: 'Dự án ghép FFmpeg', sourceMode: 'stitch', format: '16:9', targetDurationSec: 4, voiceId: 'lily' }
  }), 'create stitch project');
  const stitchProjectId = stitchProject.project.id;
  await expectOk(staff.request(`/api/projects/${stitchProjectId}`, {
    method: 'PATCH',
    body: { transitionSec: 0.5 }
  }), 'set transition');
  const stitchSceneIds = [];
  for (const [index, color] of ['red', 'blue'].entries()) {
    const scene = await expectOk(staff.request(`/api/projects/${stitchProjectId}/scenes`, {
      method: 'POST',
      body: { title: `Clip ${index + 1}`, durationSec: 2, prompt: '', voiceover: '' }
    }), 'create stitch scene');
    stitchSceneIds.push(scene.scene.id);
    const clipPath = path.join(dataDir, `clip-${index}.mp4`);
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath]);
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(clipPath)], { type: 'video/mp4' }), `clip-${index}.mp4`);
    await expectOk(staff.request(`/api/projects/${stitchProjectId}/assets?kind=scene_clip&sceneId=${scene.scene.id}`, {
      method: 'POST',
      body: form
    }), 'upload real clip');
    await expectOk(staff.request(`/api/scenes/${scene.scene.id}/review`, {
      method: 'POST',
      body: { status: 'approved', revisionNote: '' }
    }), 'approve stitch scene');
  }
  const stitchJob = await expectOk(staff.request(`/api/projects/${stitchProjectId}/jobs`, {
    method: 'POST',
    body: { kind: 'stitch' }
  }), 'create stitch job');
  assert(stitchJob.job.status === 'queued', `Stitch job should be queued for the internal worker, got ${stitchJob.job.status}`);
  let stitchStatus = null;
  for (let i = 0; i < 80; i++) {
    const jobPayload = await expectOk(staff.request(`/api/jobs/${stitchJob.job.id}`), 'poll stitch job');
    stitchStatus = jobPayload.job.status;
    if (stitchStatus === 'done' || stitchStatus === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(stitchStatus === 'done', `Stitch job should complete, got ${stitchStatus}`);
  const stitchedDetail = await expectOk(staff.request(`/api/projects/${stitchProjectId}`), 'get stitched project');
  assert(stitchedDetail.project.final_asset_id, 'Stitched project should have a final video asset');

  // --- Parity features: worker callback API ---
  const genJob = await expectOk(staff.request(`/api/projects/${stitchProjectId}/jobs`, {
    method: 'POST',
    body: { kind: 'generate' }
  }), 'create generate job');
  const unauthorized = await fetch(`${base}/api/worker/jobs/${genJob.job.id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenes: [] })
  });
  assert(unauthorized.status === 401, 'Worker callback without token should be rejected');
  const stitchClipAsset = stitchedDetail.assets.find((asset) => asset.kind === 'scene_clip');
  assert(stitchClipAsset, 'Stitch project should have scene clip assets');
  const completed = await fetch(`${base}/api/worker/jobs/${genJob.job.id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Worker-Token': 'test-worker-token' },
    body: JSON.stringify({ scenes: [{ sceneId: stitchClipAsset.scene_id, assetId: stitchClipAsset.id }], result: { message: 'ok' } })
  });
  const completedPayload = await completed.json();
  assert(completed.ok && completedPayload.ok, `Worker complete should succeed: ${JSON.stringify(completedPayload)}`);
  const genJobAfter = await expectOk(staff.request(`/api/jobs/${genJob.job.id}`), 'get generate job after callback');
  assert(genJobAfter.job.status === 'done', 'Generate job should be done after worker callback');

  // --- Parity features: delete project ---
  const tempProject = await expectOk(staff.request('/api/projects', {
    method: 'POST',
    body: { title: 'Dự án tạm để xóa' }
  }), 'create temp project');
  await expectOk(staff.request(`/api/projects/${tempProject.project.id}`, { method: 'DELETE' }), 'delete project');
  const deletedGet = await staff.request(`/api/projects/${tempProject.project.id}`);
  assert(deletedGet.response.status === 404, 'Deleted project should return 404');

  console.log('Smoke test passed: setup, roles, private workspaces, admin visibility, uploads, review gate, voiceover invalidation, Range playback, storyboard parsing, scale/move, exact reference, music library, FFmpeg stitch, worker callbacks, and project deletion.');
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

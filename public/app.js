'use strict';

const appEl = document.getElementById('app');
const toastEl = document.getElementById('toast');
const state = {
  user: null,
  csrf: null,
  needsSetup: false,
  view: 'dashboard',
  projects: [],
  currentProject: null,
  detail: null,
  users: []
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = `toast${isError ? ' error' : ''}`;
  toastEl.hidden = false;
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => { toastEl.hidden = true; }, 5200);
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { ...(options.headers || {}) };
  if (state.csrf && method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
  let body = options.body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(path, { ...options, method, headers, body, credentials: 'same-origin' });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : { ok: response.ok };
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Yêu cầu thất bại (${response.status})`);
  return payload;
}

function roleLabel(role) {
  return { admin: 'Quản trị viên', staff: 'Nhân viên biên tập', viewer: 'Chỉ xem' }[role] || role;
}

function canWrite() {
  return state.user && state.user.role !== 'viewer';
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function assetUrl(assetId, download = false) {
  return `/api/assets/${assetId}/content${download ? '?download=1' : ''}`;
}

function renderAuth(mode) {
  const isSetup = mode === 'setup';
  appEl.innerHTML = `
    <main class="auth-wrap">
      <section class="auth-card">
        <div class="eyebrow">Bản độc lập ngoài Muse</div>
        <h1>${isSetup ? 'Tạo tài khoản quản trị đầu tiên' : 'Đăng nhập App Làm Video Liền Mạch'}</h1>
        <p class="muted">${isSetup
          ? 'Tài khoản này là chủ hệ thống, có quyền tạo tài khoản nhân viên và xem toàn bộ kho dự án.'
          : 'Mỗi nhân viên dùng tài khoản riêng và chỉ thấy kho dự án của mình. Quản trị viên xem được toàn bộ.'}</p>
        <form class="form" id="auth-form">
          ${isSetup ? '<label>Họ và tên<input name="name" autocomplete="name" required></label>' : ''}
          <label>Email<input name="email" type="email" autocomplete="username" required></label>
          <label>Mật khẩu<input name="password" type="password" autocomplete="${isSetup ? 'new-password' : 'current-password'}" minlength="10" required></label>
          <button class="btn primary" type="submit">${isSetup ? 'Tạo quản trị viên và vào app' : 'Đăng nhập'}</button>
        </form>
      </section>
    </main>`;
  document.getElementById('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const payload = await api(isSetup ? '/api/setup' : '/api/login', {
        method: 'POST',
        body: Object.fromEntries(form.entries())
      });
      state.user = payload.user;
      state.csrf = payload.csrf;
      state.needsSetup = false;
      await showShell('dashboard');
      toast(isSetup ? 'Đã tạo tài khoản quản trị.' : 'Đăng nhập thành công.');
    } catch (error) {
      toast(error.message, true);
    }
  });
}

function shellTemplate(content) {
  const user = state.user;
  return `
    <div class="shell">
      <aside class="sidebar">
        <div>
          <div class="eyebrow">Video Studio</div>
          <div class="brand">Làm Video Liền Mạch</div>
          <div class="muted">Bản độc lập ngoài Muse</div>
        </div>
        <div class="user-box">
          <strong>${esc(user.name)}</strong><br>
          <span class="muted">${esc(user.email)}</span><br>
          <span class="chip gold">${esc(roleLabel(user.role))}</span>
        </div>
        <nav class="nav">
          <button class="btn ${state.view === 'dashboard' ? 'active' : ''}" data-nav="dashboard">Tổng quan</button>
          <button class="btn ${state.view === 'projects' ? 'active' : ''}" data-nav="projects">Kho dự án của tôi</button>
          ${user.role === 'admin' ? `<button class="btn ${state.view === 'admin' ? 'active' : ''}" data-nav="admin">Quản trị nhân viên</button>` : ''}
        </nav>
        <div class="spacer"></div>
        <button class="btn danger" id="logout-btn">Đăng xuất</button>
      </aside>
      <main class="main">${content}</main>
    </div>`;
}

function bindShell() {
  document.querySelectorAll('[data-nav]').forEach((button) => {
    button.addEventListener('click', () => showShell(button.dataset.nav));
  });
  const logout = document.getElementById('logout-btn');
  if (logout) logout.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch {}
    state.user = null;
    state.csrf = null;
    renderAuth('login');
  });
}

async function loadProjects() {
  const payload = await api('/api/projects');
  state.projects = payload.projects;
  return payload.projects;
}

function projectCard(project) {
  const completed = project.hasFinalVideo;
  return `
    <article class="card project-card">
      <div class="row between">
        <span class="chip ${completed ? 'good' : 'warn'}">${completed ? 'Đã có video hoàn chỉnh' : 'Chưa có video đã ghép'}</span>
        <span class="chip">${esc(project.format)}</span>
      </div>
      <h3>${esc(project.title)}</h3>
      <div class="muted">Chủ kho: ${esc(project.owner_name)} · ${project.sceneCount} cảnh · ${project.approvedSceneCount}/${project.sceneCount} cảnh đã duyệt</div>
      <div class="row">
        <span class="chip">Giọng: ${esc(project.voice_label)}</span>
        <span class="chip">${esc(project.style)}</span>
        <span class="chip">${project.target_duration_sec}s</span>
      </div>
      <button class="btn primary" data-open-project="${project.id}">Mở dự án</button>
    </article>`;
}

function bindProjectCards() {
  document.querySelectorAll('[data-open-project]').forEach((button) => {
    button.addEventListener('click', () => openProject(Number(button.dataset.openProject)));
  });
}

async function renderDashboard() {
  const projects = await loadProjects();
  const completed = projects.filter((project) => project.hasFinalVideo).length;
  const scenes = projects.reduce((sum, project) => sum + Number(project.sceneCount || 0), 0);
  const approved = projects.reduce((sum, project) => sum + Number(project.approvedSceneCount || 0), 0);
  const scope = state.user.role === 'admin' ? 'Bạn đang xem toàn bộ hệ thống với quyền quản trị.' : 'Bạn đang xem kho dự án riêng của mình.';
  appEl.innerHTML = shellTemplate(`
    <div class="topbar">
      <div><div class="eyebrow">Tổng quan</div><h1>Xin chào, ${esc(state.user.name)}</h1><p class="muted">${scope}</p></div>
      ${canWrite() ? '<button class="btn primary" id="quick-create">Tạo dự án mới</button>' : ''}
    </div>
    <section class="grid stats">
      <div class="card stat"><span class="muted">Dự án</span><strong>${projects.length}</strong></div>
      <div class="card stat"><span class="muted">Video hoàn chỉnh</span><strong>${completed}</strong></div>
      <div class="card stat"><span class="muted">Phân cảnh</span><strong>${scenes}</strong></div>
      <div class="card stat"><span class="muted">Cảnh đã duyệt</span><strong>${approved}</strong></div>
    </section>
    <section class="section">
      <h2>Dự án gần đây</h2>
      <div class="grid cards">${projects.slice(0, 6).map(projectCard).join('') || '<div class="card muted">Chưa có dự án nào.</div>'}</div>
    </section>`);
  bindShell();
  bindProjectCards();
  const quick = document.getElementById('quick-create');
  if (quick) quick.addEventListener('click', () => showShell('projects'));
}

async function renderProjects() {
  const projects = await loadProjects();
  appEl.innerHTML = shellTemplate(`
    <div class="topbar">
      <div><div class="eyebrow">Kho dự án</div><h1>${state.user.role === 'admin' ? 'Tất cả dự án trong hệ thống' : 'Kho dự án của tôi'}</h1>
      <p class="muted">${state.user.role === 'admin' ? 'Quản trị viên xem được mọi kho; quyền sửa vẫn thuộc chủ dự án.' : 'Chỉ tài khoản của bạn mới thấy các dự án này.'}</p></div>
    </div>
    ${canWrite() ? `
    <section class="card section">
      <h2>Tạo dự án mới</h2>
      <form id="project-form" class="form-grid">
        <label>Tên dự án<input name="title" required placeholder="Ví dụ: TVC sản phẩm 30 giây"></label>
        <label>Nguồn tạo
          <select name="sourceMode"><option value="image">Từ ảnh sản phẩm</option><option value="storyboard">Từ kịch bản</option><option value="stitch">Ghép clip có sẵn</option></select>
        </label>
        <label>Khung hình<select name="format"><option>16:9</option><option>9:16</option><option>1:1</option></select></label>
        <label>Thời lượng mục tiêu (giây)<input name="targetDurationSec" type="number" min="5" max="600" value="30"></label>
        <label>Phong cách<input name="style" value="cinematic"></label>
        <label>Giọng thống nhất
          <select name="voiceId"><option value="lily">Lily (Mellow Saxophone)</option><option value="aria">Aria</option></select>
        </label>
        <button class="btn primary" type="submit">Tạo dự án</button>
      </form>
    </section>` : ''}
    <section class="grid cards">${projects.map(projectCard).join('') || '<div class="card muted">Chưa có dự án nào.</div>'}</section>`);
  bindShell();
  bindProjectCards();
  const form = document.getElementById('project-form');
  if (form) form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    data.targetDurationSec = Number(data.targetDurationSec);
    try {
      const payload = await api('/api/projects', { method: 'POST', body: data });
      toast('Đã tạo dự án.');
      await openProject(payload.project.id);
    } catch (error) { toast(error.message, true); }
  });
}

function assetById(id) {
  return state.detail?.assets?.find((asset) => asset.id === Number(id));
}

function voiceStatus(scene) {
  if (!scene.voiceover) return '<span class="chip">Chưa có lời thoại</span>';
  if (scene.voice_sync_status === 'synced') return '<span class="chip good">Đã thu đúng giọng thống nhất</span>';
  if (scene.voice_sync_status === 'mismatch') return '<span class="chip warn">Lệch giọng — cần thu lại</span>';
  return '<span class="chip warn">Chưa thu giọng</span>';
}

function reviewStatus(scene) {
  if (scene.review_status === 'approved') return '<span class="chip good">Đã duyệt đạt — sẵn sàng ghép</span>';
  if (scene.review_status === 'needs_fix') return '<span class="chip warn">Chưa đạt — cần sửa</span>';
  return '<span class="chip">Chưa duyệt</span>';
}

async function uploadAsset(projectId, kind, file, sceneId = null) {
  const form = new FormData();
  form.append('file', file);
  const query = new URLSearchParams({ kind });
  if (sceneId) query.set('sceneId', String(sceneId));
  return api(`/api/projects/${projectId}/assets?${query}`, { method: 'POST', body: form });
}

function sceneCard(project, scene, index) {
  const editable = canWrite() && project.owner_id === state.user.id;
  const clip = assetById(scene.video_asset_id);
  const ref = assetById(scene.ref_asset_id);
  const audio = assetById(scene.audio_asset_id);
  return `
  <article class="card scene-card" id="scene-${scene.id}">
    <div class="scene-head">
      <div><div class="eyebrow">Cảnh ${index + 1}</div><h3>${esc(scene.title)}</h3>
      <div class="row">${reviewStatus(scene)} ${voiceStatus(scene)} <span class="chip">${scene.duration_sec} giây</span></div></div>
      ${editable ? `<button class="btn danger small" data-delete-scene="${scene.id}">Xóa cảnh</button>` : ''}
    </div>
    <div class="media-grid">
      <div>
        <strong>Clip xem trước</strong>
        ${clip ? `<video controls preload="metadata" src="${assetUrl(clip.id)}"></video>
          <div class="row"><a class="btn small" href="${assetUrl(clip.id)}" target="_blank" rel="noreferrer">Xem clip</a>
          <a class="btn small" href="${assetUrl(clip.id, true)}">Tải clip</a></div>`
        : '<p class="muted">Chưa có clip cho cảnh này.</p>'}
        ${editable ? `<form data-upload-scene="${scene.id}" class="row"><input class="file-input" type="file" name="file" accept="video/*" required><button class="btn small" type="submit">Tải clip lên</button></form>` : ''}
      </div>
      <div>
        <strong>Ảnh tham chiếu / mẫu</strong>
        ${ref ? `<img alt="Ảnh tham chiếu cảnh ${index + 1}" src="${assetUrl(ref.id)}" style="width:100%;border-radius:14px;display:block">`
        : '<p class="muted">Chưa có ảnh tham chiếu riêng cho cảnh này.</p>'}
        ${editable ? `<form data-upload-ref="${scene.id}" class="row"><input class="file-input" type="file" name="file" accept="image/*" required><button class="btn small" type="submit">Tải ảnh tham chiếu</button></form>` : ''}
        ${audio ? `<p class="muted">File giọng đã thu: ${esc(audio.original_name)} (${formatBytes(audio.size_bytes)})</p>` : ''}
      </div>
    </div>
    <form data-scene-form="${scene.id}" class="form-grid">
      <label>Tên cảnh<input name="title" value="${esc(scene.title)}" ${editable ? '' : 'disabled'}></label>
      <label>Thời lượng (giây)<input name="durationSec" type="number" min="1" max="120" step="0.5" value="${esc(scene.duration_sec)}" ${editable ? '' : 'disabled'}></label>
      <label>Chuyển động máy quay<input name="cameraMove" value="${esc(scene.camera_move)}" ${editable ? '' : 'disabled'}></label>
      <label>Chữ đồ họa / overlay<input name="overlay" value="${esc(scene.overlay)}" ${editable ? '' : 'disabled'}></label>
      <label style="grid-column:1/-1">Mô tả hình ảnh / prompt video<textarea name="prompt" ${editable ? '' : 'disabled'}>${esc(scene.prompt)}</textarea></label>
      <label style="grid-column:1/-1">Prompt ảnh tham chiếu<textarea name="refPrompt" ${editable ? '' : 'disabled'}>${esc(scene.ref_prompt)}</textarea></label>
      <label style="grid-column:1/-1">Nội dung giọng đọc AI của cảnh này<textarea name="voiceover" ${editable ? '' : 'disabled'}>${esc(scene.voiceover)}</textarea></label>
      <label style="grid-column:1/-1">Ghi chú chỉnh sửa cho clip<textarea name="revisionNote" data-revision-note="${scene.id}" ${editable ? '' : 'disabled'}>${esc(scene.revision_note)}</textarea></label>
      ${editable ? '<button class="btn primary" type="submit">Lưu cảnh và nội dung giọng đọc</button>' : ''}
    </form>
    ${editable ? `<div class="row">
      <button class="btn teal" data-review="approved" data-scene="${scene.id}">Duyệt đạt — cho ghép</button>
      <button class="btn danger" data-review="needs_fix" data-scene="${scene.id}">Chưa đạt — cần sửa</button>
      <button class="btn" data-review="pending" data-scene="${scene.id}">Đặt lại chưa duyệt</button>
      <button class="btn" data-job="revise" data-scene="${scene.id}">Gửi yêu cầu tạo lại clip</button>
    </div>` : ''}
  </article>`;
}

async function openProject(projectId) {
  state.view = 'project';
  const payload = await api(`/api/projects/${projectId}`);
  state.detail = payload;
  const project = payload.project;
  const editable = canWrite() && project.owner_id === state.user.id;
  const finalAsset = assetById(project.final_asset_id);
  const sourceAsset = assetById(project.source_asset_id);
  const voiceWords = payload.scenes.reduce((sum, scene) => sum + (scene.voiceover ? scene.voiceover.trim().split(/\s+/).length : 0), 0);
  appEl.innerHTML = shellTemplate(`
    <button class="btn" id="back-projects">← Quay lại kho dự án</button>
    <div class="topbar" style="margin-top:1rem">
      <div><div class="eyebrow">Dự án #${project.id} · Chủ kho: ${esc(project.owner_name)}</div>
      <h1>${esc(project.title)}</h1>
      <p class="muted">${project.sceneCount} cảnh · ${project.approvedSceneCount}/${project.sceneCount} cảnh đã duyệt · Giọng thống nhất: ${esc(project.voice_label)}</p></div>
      <span class="chip ${project.hasFinalVideo ? 'good' : 'warn'}">${project.hasFinalVideo ? 'Đã có video hoàn chỉnh' : 'Chưa có video đã ghép'}</span>
    </div>
    ${!editable ? '<div class="progress-note">Bạn đang xem dự án ở chế độ chỉ đọc. Chỉ chủ kho mới sửa được dự án của mình; quản trị viên vẫn xem và tải được toàn bộ.</div>' : ''}

    <section class="card section">
      <h2>Video hoàn chỉnh — xem & tải về máy</h2>
      ${finalAsset ? `<video controls preload="metadata" src="${assetUrl(finalAsset.id)}"></video>
        <div class="row" style="margin-top:.7rem"><a class="btn primary" href="${assetUrl(finalAsset.id)}" target="_blank" rel="noreferrer">Xem video</a>
        <a class="btn" href="${assetUrl(finalAsset.id, true)}">Tải về máy</a><span class="muted">${esc(finalAsset.original_name)} · ${formatBytes(finalAsset.size_bytes)}</span></div>`
      : `<p class="muted">Dự án này chưa có video đã ghép. Hãy hoàn tất clip, duyệt đủ các cảnh và đồng bộ giọng đọc trước khi gửi ghép.</p>
         ${editable ? `<form id="final-upload" class="row"><input class="file-input" type="file" name="file" accept="video/*" required><button class="btn" type="submit">Tải video hoàn chỉnh có sẵn lên</button></form>` : ''}`}
    </section>

    <section class="card section">
      <h2>Cài đặt dự án và giọng đọc thống nhất</h2>
      <form id="project-settings" class="form-grid">
        <label>Tên dự án<input name="title" value="${esc(project.title)}" ${editable ? '' : 'disabled'}></label>
        <label>Khung hình<select name="format" ${editable ? '' : 'disabled'}>${['16:9','9:16','1:1'].map((v) => `<option ${project.format === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Thời lượng mục tiêu (giây)<input name="targetDurationSec" type="number" min="5" max="600" value="${project.target_duration_sec}" ${editable ? '' : 'disabled'}></label>
        <label>Phong cách<input name="style" value="${esc(project.style)}" ${editable ? '' : 'disabled'}></label>
        <label>Chuyển động máy quay mặc định<input name="cameraStyle" value="${esc(project.camera_style)}" ${editable ? '' : 'disabled'}></label>
        <label>Một giọng cho toàn dự án
          <select name="voiceId" ${editable ? '' : 'disabled'}>
            <option value="lily" ${project.voice_id === 'lily' ? 'selected' : ''}>Lily (Mellow Saxophone)</option>
            <option value="aria" ${project.voice_id === 'aria' ? 'selected' : ''}>Aria</option>
          </select>
        </label>
        <label>Chuyển cảnh (giây)<input name="transitionSec" type="number" min="0" max="3" step="0.1" value="${project.transition_sec}" ${editable ? '' : 'disabled'}></label>
        <label>Âm lượng nhạc (0–1)<input name="musicVolume" type="number" min="0" max="1" step="0.01" value="${project.music_volume}" ${editable ? '' : 'disabled'}></label>
        ${editable ? '<button class="btn primary" type="submit">Lưu cài đặt</button>' : ''}
      </form>
      <p class="muted">Đổi giọng của dự án sẽ đánh dấu mọi bản thu cũ là lệch giọng. Sửa lời thoại một cảnh sẽ hủy bản thu cũ của cảnh đó.</p>
    </section>

    <section class="card section">
      <h2>Ảnh gốc của dự án</h2>
      ${sourceAsset ? `<img alt="Ảnh gốc dự án" src="${assetUrl(sourceAsset.id)}" style="max-width:520px;width:100%;border-radius:14px;display:block"><p class="muted">${esc(sourceAsset.original_name)} · ${formatBytes(sourceAsset.size_bytes)}</p>` : '<p class="muted">Chưa tải ảnh gốc.</p>'}
      ${editable ? `<form id="source-upload" class="row"><input class="file-input" type="file" name="file" accept="image/*" required><button class="btn" type="submit">Tải ảnh gốc</button></form>` : ''}
    </section>

    <section class="section">
      <h2>Nội dung giọng đọc — xem & chỉnh từng cảnh</h2>
      <div class="progress-note">AI chỉ đọc nguyên văn các ô “Nội dung giọng đọc AI” trong từng cảnh dưới đây. Tổng hiện tại: ${voiceWords} từ cho ${payload.scenes.length} cảnh.</div>
      <div style="height:1rem"></div>
      ${payload.scenes.map((scene, index) => sceneCard(project, scene, index)).join('') || '<div class="card muted">Dự án chưa có phân cảnh.</div>'}
    </section>

    ${editable ? `<section class="card section">
      <h2>Thêm phân cảnh</h2>
      <form id="scene-add" class="form-grid">
        <label>Tên cảnh<input name="title" required placeholder="Ví dụ: Hook mở đầu"></label>
        <label>Thời lượng (giây)<input name="durationSec" type="number" min="1" max="120" value="5"></label>
        <label>Chuyển động máy quay<input name="cameraMove" value="auto"></label>
        <label style="grid-column:1/-1">Mô tả hình ảnh<textarea name="prompt"></textarea></label>
        <label style="grid-column:1/-1">Nội dung giọng đọc<textarea name="voiceover"></textarea></label>
        <button class="btn primary" type="submit">Thêm cảnh</button>
      </form>
    </section>` : ''}

    <section class="card section">
      <h2>Tác vụ xử lý</h2>
      <p class="muted">Các tác vụ AI/TTS sẽ chạy bằng nhà cung cấp bên ngoài khi được cấu hình. Hiện tại chúng được ghi vào hàng đợi với trạng thái “chờ cấu hình nhà cung cấp”, không giả vờ đã hoàn thành.</p>
      ${editable ? `<div class="row">
        <button class="btn" data-project-job="analyze">Phân tích / dựng cảnh</button>
        <button class="btn" data-project-job="reference">Tạo ảnh tham chiếu</button>
        <button class="btn" data-project-job="generate">Sinh clip</button>
        <button class="btn" data-project-job="voiceover">Thu giọng thống nhất</button>
        <button class="btn primary" data-project-job="stitch">Ghép & xuất video</button>
      </div>` : ''}
      <div class="grid" style="margin-top:1rem">
        ${payload.jobs.map((job) => `<div class="row between"><span><strong>${esc(job.kind)}</strong> <span class="muted">${esc(job.created_at)}</span></span><span class="chip ${job.status === 'done' ? 'good' : 'gold'}">${esc(job.status)}</span></div>`).join('') || '<span class="muted">Chưa có tác vụ nào.</span>'}
      </div>
    </section>`);
  bindShell();
  document.getElementById('back-projects').addEventListener('click', () => showShell('projects'));
  bindProjectDetail(project);
}

function bindProjectDetail(project) {
  const editable = canWrite() && project.owner_id === state.user.id;
  if (!editable) return;
  const settings = document.getElementById('project-settings');
  settings.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    data.targetDurationSec = Number(data.targetDurationSec);
    data.transitionSec = Number(data.transitionSec);
    data.musicVolume = Number(data.musicVolume);
    try {
      await api(`/api/projects/${project.id}`, { method: 'PATCH', body: data });
      toast('Đã lưu cài đặt dự án.');
      await openProject(project.id);
    } catch (error) { toast(error.message, true); }
  });
  const sourceUpload = document.getElementById('source-upload');
  if (sourceUpload) sourceUpload.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get('file');
    try { await uploadAsset(project.id, 'source_image', file); toast('Đã tải ảnh gốc.'); await openProject(project.id); }
    catch (error) { toast(error.message, true); }
  });
  const finalUpload = document.getElementById('final-upload');
  if (finalUpload) finalUpload.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get('file');
    try { await uploadAsset(project.id, 'final_video', file); toast('Đã tải video hoàn chỉnh.'); await openProject(project.id); }
    catch (error) { toast(error.message, true); }
  });
  document.querySelectorAll('[data-scene-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const sceneId = Number(form.dataset.sceneForm);
      const data = Object.fromEntries(new FormData(form).entries());
      data.durationSec = Number(data.durationSec);
      try {
        const payload = await api(`/api/scenes/${sceneId}`, { method: 'PATCH', body: data });
        toast(payload.voiceoverChanged ? 'Đã lưu lời thoại mới và hủy bản thu cũ của cảnh.' : 'Đã lưu phân cảnh.');
        await openProject(project.id);
      } catch (error) { toast(error.message, true); }
    });
  });
  document.querySelectorAll('[data-upload-scene]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const sceneId = Number(form.dataset.uploadScene);
      const file = new FormData(form).get('file');
      try { await uploadAsset(project.id, 'scene_clip', file, sceneId); toast('Đã tải clip và đặt cảnh về chưa duyệt.'); await openProject(project.id); }
      catch (error) { toast(error.message, true); }
    });
  });
  document.querySelectorAll('[data-upload-ref]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const sceneId = Number(form.dataset.uploadRef);
      const file = new FormData(form).get('file');
      try { await uploadAsset(project.id, 'ref_image', file, sceneId); toast('Đã tải ảnh tham chiếu.'); await openProject(project.id); }
      catch (error) { toast(error.message, true); }
    });
  });
  document.querySelectorAll('[data-review]').forEach((button) => {
    button.addEventListener('click', async () => {
      const sceneId = Number(button.dataset.scene);
      const noteEl = document.querySelector(`[data-revision-note="${sceneId}"]`);
      try {
        await api(`/api/scenes/${sceneId}/review`, { method: 'POST', body: { status: button.dataset.review, revisionNote: noteEl ? noteEl.value : '' } });
        toast('Đã cập nhật trạng thái duyệt cảnh.');
        await openProject(project.id);
      } catch (error) { toast(error.message, true); }
    });
  });
  document.querySelectorAll('[data-delete-scene]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Xóa phân cảnh này?')) return;
      try { await api(`/api/scenes/${button.dataset.deleteScene}`, { method: 'DELETE' }); await openProject(project.id); }
      catch (error) { toast(error.message, true); }
    });
  });
  const addScene = document.getElementById('scene-add');
  addScene.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    data.durationSec = Number(data.durationSec);
    try { await api(`/api/projects/${project.id}/scenes`, { method: 'POST', body: data }); toast('Đã thêm phân cảnh.'); await openProject(project.id); }
    catch (error) { toast(error.message, true); }
  });
  document.querySelectorAll('[data-project-job]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/projects/${project.id}/jobs`, { method: 'POST', body: { kind: button.dataset.projectJob } });
        toast('Đã đưa tác vụ vào hàng đợi.');
        await openProject(project.id);
      } catch (error) { toast(error.message, true); }
    });
  });
  document.querySelectorAll('[data-job="revise"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const sceneId = Number(button.dataset.scene);
      const noteEl = document.querySelector(`[data-revision-note="${sceneId}"]`);
      try {
        await api(`/api/projects/${project.id}/jobs`, { method: 'POST', body: { kind: 'revise', scope: `scene:${sceneId}`, payload: { revisionNote: noteEl ? noteEl.value : '' } } });
        toast('Đã gửi yêu cầu tạo lại clip vào hàng đợi.');
        await openProject(project.id);
      } catch (error) { toast(error.message, true); }
    });
  });
}

async function renderAdmin() {
  const payload = await api('/api/admin/users');
  state.users = payload.users;
  appEl.innerHTML = shellTemplate(`
    <div class="topbar"><div><div class="eyebrow">Quản trị</div><h1>Tài khoản nhân viên</h1>
    <p class="muted">Mỗi người một tài khoản và một kho riêng. Quản trị xem được toàn bộ nhưng không dùng chung mật khẩu.</p></div></div>
    <section class="card section">
      <h2>Tạo tài khoản mới</h2>
      <form id="user-create" class="form-grid">
        <label>Họ và tên<input name="name" required></label>
        <label>Email<input name="email" type="email" required></label>
        <label>Mật khẩu tạm (ít nhất 10 ký tự)<input name="password" type="password" minlength="10" required></label>
        <label>Vai trò<select name="role"><option value="staff">Nhân viên biên tập</option><option value="viewer">Chỉ xem</option><option value="admin">Quản trị viên</option></select></label>
        <button class="btn primary" type="submit">Tạo tài khoản</button>
      </form>
    </section>
    <section class="card section">
      <h2>Danh sách tài khoản</h2>
      <div style="overflow:auto"><table>
        <thead><tr><th>Người dùng</th><th>Vai trò</th><th>Trạng thái</th><th>Đăng nhập gần nhất</th><th>Thao tác</th></tr></thead>
        <tbody>${state.users.map((user) => `
          <tr><td><strong>${esc(user.name)}</strong><br><span class="muted">${esc(user.email)}</span></td>
          <td>${esc(roleLabel(user.role))}</td><td>${user.isActive ? '<span class="chip good">Đang hoạt động</span>' : '<span class="chip warn">Đã khóa</span>'}</td>
          <td>${esc(user.lastLoginAt || 'Chưa đăng nhập')}</td>
          <td><div class="row">
            <button class="btn small" data-toggle-user="${user.id}" data-active="${user.isActive ? '0' : '1'}">${user.isActive ? 'Khóa' : 'Mở lại'}</button>
            <button class="btn small" data-reset-user="${user.id}">Đặt lại mật khẩu</button>
          </div></td></tr>`).join('')}</tbody>
      </table></div>
    </section>`);
  bindShell();
  document.getElementById('user-create').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/admin/users', { method: 'POST', body: Object.fromEntries(new FormData(event.currentTarget).entries()) });
      toast('Đã tạo tài khoản nhân viên.');
      await renderAdmin();
    } catch (error) { toast(error.message, true); }
  });
  document.querySelectorAll('[data-toggle-user]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/admin/users/${button.dataset.toggleUser}`, { method: 'PATCH', body: { isActive: button.dataset.active === '1' } });
        toast('Đã cập nhật trạng thái tài khoản.');
        await renderAdmin();
      } catch (error) { toast(error.message, true); }
    });
  });
  document.querySelectorAll('[data-reset-user]').forEach((button) => {
    button.addEventListener('click', async () => {
      const password = prompt('Nhập mật khẩu tạm mới (ít nhất 10 ký tự):');
      if (!password) return;
      try {
        await api(`/api/admin/users/${button.dataset.resetUser}`, { method: 'PATCH', body: { password } });
        toast('Đã đặt lại mật khẩu và đăng xuất các phiên cũ của tài khoản.');
      } catch (error) { toast(error.message, true); }
    });
  });
}

async function showShell(view) {
  state.view = view;
  try {
    if (view === 'dashboard') await renderDashboard();
    else if (view === 'projects') await renderProjects();
    else if (view === 'admin') await renderAdmin();
  } catch (error) {
    appEl.innerHTML = `<main class="auth-wrap"><section class="auth-card"><h1>Không tải được ứng dụng</h1><p class="muted">${esc(error.message)}</p><button class="btn primary" onclick="location.reload()">Tải lại</button></section></main>`;
  }
}

async function boot() {
  try {
    const payload = await api('/api/bootstrap');
    state.needsSetup = payload.needsSetup;
    state.user = payload.user;
    state.csrf = payload.csrf;
    if (payload.needsSetup) renderAuth('setup');
    else if (!payload.user) renderAuth('login');
    else await showShell('dashboard');
  } catch (error) {
    appEl.innerHTML = `<main class="auth-wrap"><section class="auth-card"><h1>Không kết nối được máy chủ</h1><p class="muted">${esc(error.message)}</p></section></main>`;
  }
}

boot();

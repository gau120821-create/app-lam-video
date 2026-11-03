'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_PATH = path.join(DATA_DIR, 'app.db');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 7);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 512) * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

fs.mkdirSync(MEDIA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'staff', 'viewer')),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    source_mode TEXT NOT NULL DEFAULT 'image',
    format TEXT NOT NULL DEFAULT '16:9',
    target_duration_sec INTEGER NOT NULL DEFAULT 30,
    style TEXT NOT NULL DEFAULT 'cinematic',
    camera_style TEXT NOT NULL DEFAULT 'auto',
    voice_id TEXT NOT NULL DEFAULT 'lily',
    voice_label TEXT NOT NULL DEFAULT 'Lily (Mellow Saxophone)',
    voice_engine_id TEXT NOT NULL DEFAULT 'avocado_v2:Lily',
    fidelity_mode TEXT NOT NULL DEFAULT 'strict100',
    music_enabled INTEGER NOT NULL DEFAULT 1,
    music_volume REAL NOT NULL DEFAULT 0.28,
    transition_sec REAL NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'draft',
    source_asset_id INTEGER,
    final_asset_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    duration_sec REAL NOT NULL DEFAULT 5,
    prompt TEXT NOT NULL DEFAULT '',
    ref_prompt TEXT NOT NULL DEFAULT '',
    voiceover TEXT NOT NULL DEFAULT '',
    overlay TEXT NOT NULL DEFAULT '',
    camera_move TEXT NOT NULL DEFAULT 'auto',
    review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'needs_fix')),
    revision_note TEXT NOT NULL DEFAULT '',
    revision_count INTEGER NOT NULL DEFAULT 0,
    reviewed_at TEXT,
    ref_asset_id INTEGER,
    video_asset_id INTEGER,
    audio_asset_id INTEGER,
    audio_voice_id TEXT,
    voice_sync_status TEXT NOT NULL DEFAULT 'not_recorded',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    scene_id INTEGER REFERENCES scenes(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    original_name TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    scope TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    payload_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    details_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
  CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(project_id, position);
  CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at DESC);
`);

// Lightweight migrations for parity features added after phase 1.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('projects', 'music_asset_id', 'INTEGER');
ensureColumn('scenes', 'ref_exact', 'INTEGER NOT NULL DEFAULT 0');

const VOICES = {
  lily: { label: 'Lily (Mellow Saxophone)', engineId: 'avocado_v2:Lily' },
  aria: { label: 'Aria', engineId: 'avocado_v2:MAI_01' }
};
const PROJECT_FORMATS = new Set(['16:9', '9:16', '1:1']);
const SOURCE_MODES = new Set(['image', 'storyboard', 'stitch']);
const ASSET_KINDS = new Set(['source_image', 'ref_image', 'scene_clip', 'audio', 'final_video', 'music']);
const JOB_KINDS = new Set(['analyze', 'reference', 'generate', 'voiceover', 'stitch', 'revise']);

function now() {
  return new Date().toISOString();
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function fail(res, status, message) {
  return json(res, status, { ok: false, error: message });
}

function parseCookies(req) {
  const result = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: Boolean(user.is_active),
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at
  };
}

function createSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO sessions (token_hash, csrf_token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(tokenHash(token), csrf, user.id, expires.toISOString(), now());
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwardedProto === 'https' || req.socket.encrypted;
  res.setHeader('Set-Cookie', [
    `sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${secure ? '; Secure' : ''}`
  ]);
  return csrf;
}

function getAuth(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.csrf_token, s.expires_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(tokenHash(token));
  if (!row || row.expires_at <= now() || !row.is_active) return null;
  return { user: row, csrf: row.csrf_token };
}

function requireAuth(req, res) {
  const auth = getAuth(req);
  if (!auth) {
    fail(res, 401, 'Bạn cần đăng nhập.');
    return null;
  }
  return auth;
}

function checkCsrf(req, res, auth) {
  if (req.headers['x-csrf-token'] !== auth.csrf) {
    fail(res, 403, 'Phiên bảo mật không hợp lệ. Hãy tải lại trang.');
    return false;
  }
  return true;
}

function requireWrite(res, auth) {
  if (auth.user.role === 'viewer') {
    fail(res, 403, 'Tài khoản chỉ xem không thể thay đổi dữ liệu.');
    return false;
  }
  return true;
}

function audit(userId, action, entityType, entityId, details) {
  db.prepare('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId || null, action, entityType || null, entityId || null, details ? JSON.stringify(details) : null, now());
}

async function readRaw(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('Dữ liệu gửi lên quá lớn.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readRaw(req, MAX_JSON_BYTES);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Dữ liệu JSON không hợp lệ.'), { status: 400 });
  }
}

function cleanText(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function projectRow(row) {
  if (!row) return null;
  return {
    ...row,
    musicEnabled: Boolean(row.music_enabled),
    sceneCount: Number(row.scene_count || 0),
    approvedSceneCount: Number(row.approved_scene_count || 0),
    hasFinalVideo: Boolean(row.final_asset_id)
  };
}

function getProjectRow(id) {
  return db.prepare(`
    SELECT p.*, u.name AS owner_name, u.email AS owner_email,
      (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id) AS scene_count,
      (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id AND s.review_status = 'approved') AS approved_scene_count
    FROM projects p JOIN users u ON u.id = p.owner_id
    WHERE p.id = ?
  `).get(id);
}

function canReadProject(user, project) {
  return Boolean(project && (user.role === 'admin' || project.owner_id === user.id));
}

function canWriteProject(user, project) {
  return Boolean(project && project.owner_id === user.id && user.role !== 'viewer');
}

function getAccessibleProject(req, res, auth, id, write = false) {
  const project = getProjectRow(id);
  if (!project || !canReadProject(auth.user, project)) {
    fail(res, 404, 'Không tìm thấy dự án.');
    return null;
  }
  if (write && !canWriteProject(auth.user, project)) {
    fail(res, 403, 'Bạn chỉ có quyền sửa dự án trong kho của mình.');
    return null;
  }
  return project;
}

function getScene(id) {
  return db.prepare('SELECT * FROM scenes WHERE id = ?').get(id);
}

function parseStoryboard(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  const markerRe = /^\s*(?:cảnh|scene|shot|khung|phân cảnh)\s*(\d+)\s*[:.\-]?\s*(.*)$/i;
  const numberedRe = /^\s*(\d{1,2})[.)]\s+(.*)$/;
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const marker = line.match(markerRe);
    const numbered = !marker ? line.match(numberedRe) : null;
    if (marker || numbered) {
      if (current) blocks.push(current);
      current = { title: (marker ? marker[2] : numbered[2] || '').trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      current = { title: '', lines: [line] };
    }
  }
  if (current) blocks.push(current);
  let sceneBlocks = blocks;
  if (sceneBlocks.length <= 1) {
    const byBlank = raw.split(/\n\s*\n/).map((chunk) => chunk.trim()).filter(Boolean);
    if (byBlank.length > 1) sceneBlocks = byBlank.map((chunk) => ({ title: '', lines: chunk.split('\n') }));
  }
  return sceneBlocks.map((block, idx) => {
    const bodyLines = (block.lines || []).map((line) => line.trim()).filter(Boolean);
    let duration = 5;
    let voiceover = '';
    let overlay = '';
    const promptLines = [];
    for (const line of [...(block.title ? [block.title] : []), ...bodyLines]) {
      const dm = line.match(/(\d+(?:[.,]\d+)?)\s*(giây|sec|secs|s)\b/i);
      if (dm) { duration = Math.min(120, Math.max(1, parseFloat(dm[1].replace(',', '.')))); break; }
    }
    for (const line of bodyLines) {
      const vo = line.match(/^(?:lời thoại|voiceover|vo|thoại)\s*[:：]\s*(.+)$/i);
      const ov = line.match(/^(?:chữ|overlay|text|đồ họa|chữ đồ họa)\s*[:：]\s*(.+)$/i);
      if (vo) voiceover = vo[1].trim();
      else if (ov) overlay = ov[1].trim();
      else promptLines.push(line);
    }
    if (!voiceover) {
      const quoted = bodyLines.join(' ').match(/[“"]([^”"]{10,})[”"]/);
      if (quoted) voiceover = quoted[1].trim();
    }
    return {
      title: block.title && block.title.length <= 120 ? block.title : `Cảnh ${idx + 1}`,
      durationSec: duration,
      prompt: promptLines.join('\n'),
      voiceover,
      overlay
    };
  }).filter((scene) => scene.prompt || scene.voiceover || scene.title);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).slice(-800)));
      else resolve({ stdout, stderr });
    });
  });
}

async function processStitchJob(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job || job.kind !== 'stitch') return;
  const setJob = (status, result, error) => db.prepare('UPDATE jobs SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?')
    .run(status, result ? JSON.stringify(result) : null, error || null, now(), jobId);
  setJob('running', { message: 'Worker FFmpeg đang ghép video.' }, null);
  const project = getProjectRow(job.project_id);
  const scenes = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY position ASC, id ASC').all(job.project_id);
  const assetById = (id) => id ? db.prepare('SELECT * FROM assets WHERE id = ?').get(id) : null;
  const dims = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [960, 960] }[project.format] || [1280, 720];
  const [width, height] = dims;
  const transition = Math.max(0, Number(project.transition_sec) || 0);
  const tmpDir = path.join(DATA_DIR, 'tmp', `job-${jobId}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const normPaths = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const clip = assetById(scene.video_asset_id);
      if (!clip) throw new Error(`Cảnh "${scene.title}" chưa có clip.`);
      const src = path.join(MEDIA_DIR, clip.storage_path);
      const out = path.join(tmpDir, `norm-${i}.mp4`);
      await runFfmpeg(['-y', '-stream_loop', '-1', '-i', src,
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30,format=yuv420p`,
        '-t', String(scene.duration_sec), '-an', '-c:v', 'libx264', '-preset', 'veryfast', out]);
      normPaths.push(out);
    }
    const durations = scenes.map((scene) => Number(scene.duration_sec));
    const totalDuration = durations.reduce((a, b) => a + b, 0) - transition * (scenes.length - 1);
    const useXfade = transition > 0 && scenes.length > 1 && durations.every((d) => d > transition);
    const inputs = [];
    normPaths.forEach((p) => inputs.push('-i', p));
    const filters = [];
    let videoLabel = '0:v';
    if (scenes.length > 1 && useXfade) {
      let acc = durations[0];
      let currentLabel = '0:v';
      for (let k = 1; k < scenes.length; k++) {
        const offset = Math.max(0, acc - transition);
        const outLabel = `v${k}`;
        filters.push(`[${currentLabel}][${k}:v]xfade=transition=fade:duration=${transition}:offset=${offset}[${outLabel}]`);
        acc = acc + durations[k] - transition;
        currentLabel = outLabel;
      }
      videoLabel = currentLabel;
    } else if (scenes.length > 1) {
      const concatInputs = scenes.map((_, i) => `[${i}:v]`).join('');
      filters.push(`${concatInputs}concat=n=${scenes.length}:v=1:a=0[vcat]`);
      videoLabel = 'vcat';
    }
    let inputIndex = scenes.length;
    const audioLabels = [];
    let elapsed = 0;
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      if (i > 0) elapsed += durations[i - 1] - (useXfade ? transition : 0);
      const audio = assetById(scene.audio_asset_id);
      if (audio) {
        inputs.push('-i', path.join(MEDIA_DIR, audio.storage_path));
        const label = `a${i}`;
        filters.push(`[${inputIndex}:a]adelay=${Math.round(elapsed * 1000)}:all=1,apad[${label}]`);
        audioLabels.push(`[${label}]`);
        inputIndex++;
      }
    }
    if (project.music_asset_id) {
      const music = assetById(project.music_asset_id);
      if (music) {
        inputs.push('-stream_loop', '-1', '-i', path.join(MEDIA_DIR, music.storage_path));
        const fadeStart = Math.max(0, totalDuration - 3);
        filters.push(`[${inputIndex}:a]volume=${Number(project.music_volume) || 0.28},afade=t=out:st=${fadeStart}:d=3,apad[amusic]`);
        audioLabels.push('[amusic]');
        inputIndex++;
      }
    }
    let audioLabel = null;
    if (audioLabels.length === 1) {
      audioLabel = audioLabels[0].slice(1, -1);
    } else if (audioLabels.length > 1) {
      filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:normalize=0[aout]`);
      audioLabel = 'aout';
    } else {
      inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      audioLabel = `${inputIndex}:a`;
      inputIndex++;
    }
    const outputTmp = path.join(tmpDir, 'final.mp4');
    const args = ['-y', ...inputs];
    if (filters.length) args.push('-filter_complex', filters.join(';'));
    const videoMap = scenes.length > 1 ? `[${videoLabel}]` : '0:v';
    const audioMap = audioLabel.includes(':') ? audioLabel : `[${audioLabel}]`;
    args.push('-map', videoMap, '-map', audioMap,
      '-t', String(totalDuration), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', outputTmp);
    await runFfmpeg(args);
    const storageRelative = path.join(String(project.owner_id), String(project.id), `final_video-${crypto.randomUUID()}.mp4`);
    const storageAbsolute = path.join(MEDIA_DIR, storageRelative);
    fs.mkdirSync(path.dirname(storageAbsolute), { recursive: true });
    fs.copyFileSync(outputTmp, storageAbsolute);
    const data = fs.readFileSync(storageAbsolute);
    const timestamp = now();
    const info = db.prepare(`
      INSERT INTO assets (owner_id, project_id, scene_id, kind, original_name, storage_path, mime_type, size_bytes, sha256, created_at)
      VALUES (?, ?, NULL, 'final_video', ?, ?, 'video/mp4', ?, ?, ?)
    `).run(project.owner_id, project.id, `${project.title} — video hoàn chỉnh.mp4`, storageRelative, data.length,
      crypto.createHash('sha256').update(data).digest('hex'), timestamp);
    const finalAssetId = Number(info.lastInsertRowid);
    db.prepare('UPDATE projects SET final_asset_id = ?, status = ?, updated_at = ? WHERE id = ?').run(finalAssetId, 'completed', timestamp, project.id);
    setJob('done', { finalAssetId, durationSec: totalDuration, message: 'Ghép hoàn tất bằng worker FFmpeg nội bộ.' }, null);
  } catch (error) {
    setJob('failed', null, String(error.message || error).slice(0, 800));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let cursor = buffer.indexOf(delimiter);
  while (cursor !== -1) {
    let partStart = cursor + delimiter.length;
    if (buffer[partStart] === 45 && buffer[partStart + 1] === 45) break;
    if (buffer[partStart] === 13 && buffer[partStart + 1] === 10) partStart += 2;
    const next = buffer.indexOf(delimiter, partStart);
    if (next === -1) break;
    let partEnd = next;
    if (partEnd >= 2 && buffer[partEnd - 2] === 13 && buffer[partEnd - 1] === 10) partEnd -= 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), partStart);
    if (headerEnd !== -1 && headerEnd < partEnd) {
      const headers = buffer.subarray(partStart, headerEnd).toString('utf8');
      const body = buffer.subarray(headerEnd + 4, partEnd);
      const disposition = headers.split('\r\n').find((line) => line.toLowerCase().startsWith('content-disposition:')) || '';
      const nameMatch = disposition.match(/name="([^"]+)"/);
      const filenameMatch = disposition.match(/filename="([^"]*)"/);
      const typeMatch = headers.split('\r\n').find((line) => line.toLowerCase().startsWith('content-type:'));
      if (nameMatch) {
        if (filenameMatch && filenameMatch[1]) {
          files.push({
            field: nameMatch[1],
            filename: filenameMatch[1],
            mimeType: typeMatch ? typeMatch.split(':')[1].trim() : 'application/octet-stream',
            data: Buffer.from(body)
          });
        } else {
          fields[nameMatch[1]] = body.toString('utf8');
        }
      }
    }
    cursor = next;
  }
  return { fields, files };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (method === 'GET' && url.pathname === '/api/bootstrap') {
    const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    const auth = getAuth(req);
    return json(res, 200, { ok: true, needsSetup: count === 0, user: publicUser(auth?.user), csrf: auth?.csrf || null });
  }

  if (method === 'POST' && url.pathname === '/api/setup') {
    const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    if (count > 0) return fail(res, 409, 'Tài khoản quản trị đầu tiên đã được tạo.');
    const body = await readJson(req);
    const name = cleanText(body.name, 120);
    const email = cleanText(body.email, 200).toLowerCase();
    const password = String(body.password || '');
    if (!name || !email.includes('@') || password.length < 10) {
      return fail(res, 400, 'Cần nhập tên, email hợp lệ và mật khẩu ít nhất 10 ký tự.');
    }
    const createdAt = now();
    const info = db.prepare('INSERT INTO users (name, email, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(name, email, hashPassword(password), 'admin', createdAt);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    const csrf = createSession(req, res, user);
    audit(user.id, 'setup_admin', 'user', user.id, { email });
    return json(res, 201, { ok: true, user: publicUser(user), csrf });
  }

  if (method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(req);
    const email = cleanText(body.email, 200).toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !user.is_active || !verifyPassword(String(body.password || ''), user.password_hash)) {
      return fail(res, 401, 'Email hoặc mật khẩu không đúng, hoặc tài khoản đã bị khóa.');
    }
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);
    const csrf = createSession(req, res, user);
    audit(user.id, 'login', 'user', user.id, {});
    return json(res, 200, { ok: true, user: publicUser(user), csrf });
  }

  // Worker/provider callbacks (token-authenticated, no user session).
  if (parts[1] === 'worker' && method === 'POST') {
    const expected = process.env.WORKER_TOKEN || '';
    if (!expected) return fail(res, 503, 'WORKER_TOKEN chưa được cấu hình trên máy chủ.');
    if (req.headers['x-worker-token'] !== expected) return fail(res, 401, 'Worker token không hợp lệ.');
    const jobId = Number(parts[3]);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job || parts[2] !== 'jobs') return fail(res, 404, 'Không tìm thấy tác vụ.');
    const body = await readJson(req);
    if (parts[4] === 'fail') {
      db.prepare('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('failed', cleanText(body.error || 'Worker báo lỗi.', 800), now(), jobId);
      return json(res, 200, { ok: true });
    }
    if (parts[4] === 'complete') {
      const project = getProjectRow(job.project_id);
      for (const item of Array.isArray(body.scenes) ? body.scenes : []) {
        const scene = getScene(Number(item.sceneId));
        const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(item.assetId));
        if (!scene || !asset || scene.project_id !== job.project_id || asset.project_id !== job.project_id) continue;
        if (job.kind === 'voiceover') {
          db.prepare('UPDATE scenes SET audio_asset_id = ?, audio_voice_id = ?, voice_sync_status = ?, updated_at = ? WHERE id = ?')
            .run(asset.id, project.voice_id, 'synced', now(), scene.id);
        } else if (job.kind === 'reference') {
          db.prepare('UPDATE scenes SET ref_asset_id = ?, ref_exact = 0, updated_at = ? WHERE id = ?').run(asset.id, now(), scene.id);
        } else {
          db.prepare('UPDATE scenes SET video_asset_id = ?, review_status = ?, reviewed_at = NULL, updated_at = ? WHERE id = ?')
            .run(asset.id, 'pending', now(), scene.id);
        }
      }
      if (body.finalAssetId) {
        const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(body.finalAssetId));
        if (asset && asset.project_id === job.project_id) {
          db.prepare('UPDATE projects SET final_asset_id = ?, status = ?, updated_at = ? WHERE id = ?')
            .run(asset.id, 'completed', now(), job.project_id);
        }
      }
      db.prepare('UPDATE jobs SET status = ?, result_json = ?, error = NULL, updated_at = ? WHERE id = ?')
        .run('done', JSON.stringify(body.result || { message: 'Worker đã giao kết quả.' }), now(), jobId);
      return json(res, 200, { ok: true });
    }
    return fail(res, 404, 'Không tìm thấy callback.');
  }

  const auth = requireAuth(req, res);
  if (!auth) return;

  if (method === 'GET' && url.pathname === '/api/me') {
    return json(res, 200, { ok: true, user: publicUser(auth.user), csrf: auth.csrf });
  }

  if (method === 'POST' && url.pathname === '/api/logout') {
    if (!checkCsrf(req, res, auth)) return;
    const token = parseCookies(req).sid;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method);
  if (mutating && !checkCsrf(req, res, auth)) return;

  // Admin: user management
  if (parts[1] === 'admin') {
    if (auth.user.role !== 'admin') return fail(res, 403, 'Chỉ quản trị viên mới dùng được mục này.');
    if (method === 'GET' && url.pathname === '/api/admin/users') {
      const users = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all().map(publicUser);
      return json(res, 200, { ok: true, users });
    }
    if (method === 'POST' && url.pathname === '/api/admin/users') {
      if (!requireWrite(res, auth)) return;
      const body = await readJson(req);
      const name = cleanText(body.name, 120);
      const email = cleanText(body.email, 200).toLowerCase();
      const password = String(body.password || '');
      const role = ['admin', 'staff', 'viewer'].includes(body.role) ? body.role : 'staff';
      if (!name || !email.includes('@') || password.length < 10) {
        return fail(res, 400, 'Cần nhập tên, email hợp lệ và mật khẩu tạm ít nhất 10 ký tự.');
      }
      try {
        const info = db.prepare('INSERT INTO users (name, email, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
          .run(name, email, hashPassword(password), role, now());
        audit(auth.user.id, 'create_user', 'user', Number(info.lastInsertRowid), { email, role });
        return json(res, 201, { ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) });
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) return fail(res, 409, 'Email này đã có tài khoản.');
        throw error;
      }
    }
    if (method === 'PATCH' && parts[2] === 'users' && parts[3]) {
      const targetId = Number(parts[3]);
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
      if (!target) return fail(res, 404, 'Không tìm thấy tài khoản.');
      const body = await readJson(req);
      if (target.id === auth.user.id && (body.isActive === false || (body.role && body.role !== 'admin'))) {
        return fail(res, 400, 'Không thể tự khóa hoặc tự hạ quyền tài khoản quản trị đang đăng nhập.');
      }
      const role = ['admin', 'staff', 'viewer'].includes(body.role) ? body.role : target.role;
      const isActive = typeof body.isActive === 'boolean' ? (body.isActive ? 1 : 0) : target.is_active;
      db.prepare('UPDATE users SET role = ?, is_active = ? WHERE id = ?').run(role, isActive, targetId);
      if (body.password) {
        if (String(body.password).length < 10) return fail(res, 400, 'Mật khẩu mới cần ít nhất 10 ký tự.');
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.password)), targetId);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
      }
      if (!isActive) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
      audit(auth.user.id, 'update_user', 'user', targetId, { role, isActive: Boolean(isActive), passwordReset: Boolean(body.password) });
      return json(res, 200, { ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(targetId)) });
    }
    if (method === 'GET' && url.pathname === '/api/admin/audit') {
      const logs = db.prepare(`
        SELECT a.*, u.name AS user_name, u.email AS user_email
        FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.id DESC LIMIT 100
      `).all();
      return json(res, 200, { ok: true, logs });
    }
    return fail(res, 404, 'Không tìm thấy chức năng quản trị.');
  }

  // Projects
  if (method === 'GET' && url.pathname === '/api/projects') {
    const rows = auth.user.role === 'admin'
      ? db.prepare(`
          SELECT p.*, u.name AS owner_name, u.email AS owner_email,
            (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id) AS scene_count,
            (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id AND s.review_status = 'approved') AS approved_scene_count
          FROM projects p JOIN users u ON u.id = p.owner_id ORDER BY p.updated_at DESC
        `).all()
      : db.prepare(`
          SELECT p.*, u.name AS owner_name, u.email AS owner_email,
            (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id) AS scene_count,
            (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id AND s.review_status = 'approved') AS approved_scene_count
          FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.owner_id = ? ORDER BY p.updated_at DESC
        `).all(auth.user.id);
    return json(res, 200, { ok: true, projects: rows.map(projectRow) });
  }

  if (method === 'POST' && url.pathname === '/api/projects') {
    if (!requireWrite(res, auth)) return;
    const body = await readJson(req);
    const title = cleanText(body.title, 250);
    if (!title) return fail(res, 400, 'Cần nhập tên dự án.');
    const voiceId = VOICES[body.voiceId] ? body.voiceId : 'lily';
    const timestamp = now();
    const info = db.prepare(`
      INSERT INTO projects (
        owner_id, title, source_mode, format, target_duration_sec, style, camera_style,
        voice_id, voice_label, voice_engine_id, fidelity_mode, music_enabled, music_volume,
        transition_sec, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).run(
      auth.user.id,
      title,
      SOURCE_MODES.has(body.sourceMode) ? body.sourceMode : 'image',
      PROJECT_FORMATS.has(body.format) ? body.format : '16:9',
      Math.round(clampNumber(body.targetDurationSec, 5, 600, 30)),
      cleanText(body.style || 'cinematic', 80),
      cleanText(body.cameraStyle || 'auto', 80),
      voiceId,
      VOICES[voiceId].label,
      VOICES[voiceId].engineId,
      body.fidelityMode === 'standard' ? 'standard' : 'strict100',
      body.musicEnabled === false ? 0 : 1,
      clampNumber(body.musicVolume, 0, 1, 0.28),
      clampNumber(body.transitionSec, 0, 3, 0.5),
      timestamp,
      timestamp
    );
    audit(auth.user.id, 'create_project', 'project', Number(info.lastInsertRowid), { title });
    return json(res, 201, { ok: true, project: projectRow(getProjectRow(info.lastInsertRowid)) });
  }

  if (parts[1] === 'projects' && parts[2]) {
    const projectId = Number(parts[2]);
    if (method === 'GET' && parts.length === 3) {
      const project = getAccessibleProject(req, res, auth, projectId);
      if (!project) return;
      const scenes = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY position ASC, id ASC').all(projectId);
      const assets = db.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
      const jobs = db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 30').all(projectId);
      return json(res, 200, { ok: true, project: projectRow(project), scenes, assets, jobs });
    }
    if (method === 'PATCH' && parts.length === 3) {
      const project = getAccessibleProject(req, res, auth, projectId, true);
      if (!project) return;
      const body = await readJson(req);
      const updates = {
        title: body.title !== undefined ? cleanText(body.title, 250) : project.title,
        source_mode: SOURCE_MODES.has(body.sourceMode) ? body.sourceMode : project.source_mode,
        format: PROJECT_FORMATS.has(body.format) ? body.format : project.format,
        target_duration_sec: body.targetDurationSec !== undefined ? Math.round(clampNumber(body.targetDurationSec, 5, 600, project.target_duration_sec)) : project.target_duration_sec,
        style: body.style !== undefined ? cleanText(body.style, 80) : project.style,
        camera_style: body.cameraStyle !== undefined ? cleanText(body.cameraStyle, 80) : project.camera_style,
        fidelity_mode: body.fidelityMode !== undefined ? (body.fidelityMode === 'standard' ? 'standard' : 'strict100') : project.fidelity_mode,
        music_enabled: body.musicEnabled !== undefined ? (body.musicEnabled ? 1 : 0) : project.music_enabled,
        music_volume: body.musicVolume !== undefined ? clampNumber(body.musicVolume, 0, 1, project.music_volume) : project.music_volume,
        transition_sec: body.transitionSec !== undefined ? clampNumber(body.transitionSec, 0, 3, project.transition_sec) : project.transition_sec,
        status: body.status !== undefined ? cleanText(body.status, 50) : project.status
      };
      if (!updates.title) return fail(res, 400, 'Tên dự án không được trống.');
      let voice = { id: project.voice_id, label: project.voice_label, engineId: project.voice_engine_id };
      if (body.voiceId && VOICES[body.voiceId] && body.voiceId !== project.voice_id) {
        voice = { id: body.voiceId, label: VOICES[body.voiceId].label, engineId: VOICES[body.voiceId].engineId };
        db.prepare(`
          UPDATE scenes SET voice_sync_status = CASE WHEN audio_asset_id IS NULL THEN 'not_recorded' ELSE 'mismatch' END, updated_at = ?
          WHERE project_id = ?
        `).run(now(), projectId);
      }
      let musicAssetId = project.music_asset_id;
      if (body.musicAssetId !== undefined) {
        if (body.musicAssetId === null) musicAssetId = null;
        else {
          const music = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(body.musicAssetId));
          if (!music || music.kind !== 'music' || music.owner_id !== project.owner_id) {
            return fail(res, 400, 'Nhạc nền không thuộc kho của chủ dự án.');
          }
          musicAssetId = music.id;
        }
      }
      db.prepare(`
        UPDATE projects SET title = ?, source_mode = ?, format = ?, target_duration_sec = ?, style = ?, camera_style = ?,
          voice_id = ?, voice_label = ?, voice_engine_id = ?, fidelity_mode = ?, music_enabled = ?, music_volume = ?,
          transition_sec = ?, status = ?, music_asset_id = ?, updated_at = ? WHERE id = ?
      `).run(updates.title, updates.source_mode, updates.format, updates.target_duration_sec, updates.style, updates.camera_style,
        voice.id, voice.label, voice.engineId, updates.fidelity_mode, updates.music_enabled, updates.music_volume,
        updates.transition_sec, updates.status, musicAssetId, now(), projectId);
      audit(auth.user.id, 'update_project', 'project', projectId, { voiceChanged: voice.id !== project.voice_id });
      return json(res, 200, { ok: true, project: projectRow(getProjectRow(projectId)) });
    }
    if (method === 'POST' && parts[3] === 'scenes' && parts.length === 4) {
      const project = getAccessibleProject(req, res, auth, projectId, true);
      if (!project) return;
      const body = await readJson(req);
      const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS max_position FROM scenes WHERE project_id = ?').get(projectId).max_position;
      const timestamp = now();
      const info = db.prepare(`
        INSERT INTO scenes (project_id, position, title, duration_sec, prompt, ref_prompt, voiceover, overlay, camera_move, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, max + 1, cleanText(body.title || 'Phân cảnh mới', 200), clampNumber(body.durationSec, 1, 120, 5),
        cleanText(body.prompt), cleanText(body.refPrompt), cleanText(body.voiceover), cleanText(body.overlay, 500),
        cleanText(body.cameraMove || 'auto', 80), timestamp, timestamp);
      db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(timestamp, projectId);
      return json(res, 201, { ok: true, scene: getScene(info.lastInsertRowid) });
    }
    if (method === 'POST' && parts[3] === 'jobs' && parts.length === 4) {
      const project = getAccessibleProject(req, res, auth, projectId, true);
      if (!project) return;
      const body = await readJson(req);
      const kind = String(body.kind || '');
      if (!JOB_KINDS.has(kind)) return fail(res, 400, 'Loại tác vụ không hợp lệ.');
      if (kind === 'stitch') {
        const scenes = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY position').all(projectId);
        if (!scenes.length) return fail(res, 400, 'Dự án chưa có phân cảnh nào.');
        const blockers = [];
        for (const scene of scenes) {
          if (!scene.video_asset_id) blockers.push(`${scene.title}: chưa có clip`);
          if (scene.review_status !== 'approved') blockers.push(`${scene.title}: chưa duyệt đạt`);
          if (scene.voiceover && !scene.audio_asset_id) blockers.push(`${scene.title}: có lời thoại nhưng chưa thu giọng`);
          if (scene.voice_sync_status === 'mismatch') blockers.push(`${scene.title}: giọng đang lệch`);
        }
        if (blockers.length) return fail(res, 400, `Chưa thể ghép. ${blockers.join('; ')}`);
      }
      const timestamp = now();
      const isStitch = kind === 'stitch';
      const initialStatus = isStitch ? 'queued' : 'waiting_provider';
      const initialResult = isStitch
        ? { message: 'Đã vào hàng đợi ghép. Worker FFmpeg nội bộ sẽ xử lý từ các clip có sẵn.' }
        : { message: 'Đã vào hàng đợi. Cần cấu hình nhà cung cấp xử lý bên ngoài trước khi tác vụ chạy thật.' };
      const info = db.prepare(`
        INSERT INTO jobs (owner_id, project_id, kind, scope, status, payload_json, result_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(auth.user.id, projectId, kind, cleanText(body.scope || '', 200), initialStatus, JSON.stringify(body.payload || {}),
        JSON.stringify(initialResult), timestamp, timestamp);
      const jobId = Number(info.lastInsertRowid);
      audit(auth.user.id, 'create_job', 'job', jobId, { kind, projectId });
      if (isStitch) setImmediate(() => { processStitchJob(jobId).catch((error) => console.error('Stitch job failed', jobId, error)); });
      return json(res, 201, { ok: true, job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) });
    }
  }

  if (parts[1] === 'scenes' && parts[2]) {
    const sceneId = Number(parts[2]);
    const scene = getScene(sceneId);
    if (!scene) return fail(res, 404, 'Không tìm thấy phân cảnh.');
    if (method === 'PATCH' && parts.length === 3) {
      const project = getAccessibleProject(req, res, auth, scene.project_id, true);
      if (!project) return;
      const body = await readJson(req);
      const voiceoverChanged = body.voiceover !== undefined && cleanText(body.voiceover) !== scene.voiceover;
      const updated = {
        title: body.title !== undefined ? cleanText(body.title, 200) : scene.title,
        duration_sec: body.durationSec !== undefined ? clampNumber(body.durationSec, 1, 120, scene.duration_sec) : scene.duration_sec,
        prompt: body.prompt !== undefined ? cleanText(body.prompt) : scene.prompt,
        ref_prompt: body.refPrompt !== undefined ? cleanText(body.refPrompt) : scene.ref_prompt,
        voiceover: body.voiceover !== undefined ? cleanText(body.voiceover) : scene.voiceover,
        overlay: body.overlay !== undefined ? cleanText(body.overlay, 500) : scene.overlay,
        camera_move: body.cameraMove !== undefined ? cleanText(body.cameraMove, 80) : scene.camera_move
      };
      if (!updated.title) return fail(res, 400, 'Tên phân cảnh không được trống.');
      if (voiceoverChanged) {
        db.prepare(`
          UPDATE scenes SET title = ?, duration_sec = ?, prompt = ?, ref_prompt = ?, voiceover = ?, overlay = ?, camera_move = ?,
            audio_asset_id = NULL, audio_voice_id = NULL, voice_sync_status = 'not_recorded', updated_at = ? WHERE id = ?
        `).run(updated.title, updated.duration_sec, updated.prompt, updated.ref_prompt, updated.voiceover, updated.overlay, updated.camera_move, now(), sceneId);
      } else {
        db.prepare(`
          UPDATE scenes SET title = ?, duration_sec = ?, prompt = ?, ref_prompt = ?, voiceover = ?, overlay = ?, camera_move = ?, updated_at = ? WHERE id = ?
        `).run(updated.title, updated.duration_sec, updated.prompt, updated.ref_prompt, updated.voiceover, updated.overlay, updated.camera_move, now(), sceneId);
      }
      return json(res, 200, { ok: true, scene: getScene(sceneId), voiceoverChanged });
    }
    if (method === 'POST' && parts[3] === 'review') {
      const project = getAccessibleProject(req, res, auth, scene.project_id, true);
      if (!project) return;
      const body = await readJson(req);
      const status = String(body.status || '');
      if (!['pending', 'approved', 'needs_fix'].includes(status)) return fail(res, 400, 'Trạng thái duyệt không hợp lệ.');
      const revisionNote = body.revisionNote !== undefined ? cleanText(body.revisionNote, 2000) : scene.revision_note;
      if (status === 'needs_fix' && !revisionNote) return fail(res, 400, 'Muốn đánh dấu cần sửa, hãy ghi rõ nội dung cần sửa.');
      if (status === 'approved' && !scene.video_asset_id) return fail(res, 400, 'Cảnh chưa có clip nên chưa thể duyệt đạt.');
      db.prepare(`
        UPDATE scenes SET review_status = ?, revision_note = ?, revision_count = revision_count + ?, reviewed_at = ?, updated_at = ? WHERE id = ?
      `).run(status, revisionNote, status === 'needs_fix' ? 1 : 0, status === 'pending' ? null : now(), now(), sceneId);
      audit(auth.user.id, 'review_scene', 'scene', sceneId, { status });
      return json(res, 200, { ok: true, scene: getScene(sceneId) });
    }
    if (method === 'DELETE' && parts.length === 3) {
      const project = getAccessibleProject(req, res, auth, scene.project_id, true);
      if (!project) return;
      db.prepare('DELETE FROM scenes WHERE id = ?').run(sceneId);
      return json(res, 200, { ok: true });
    }
  }

  if (method === 'POST' && parts[1] === 'projects' && parts[2] && parts[3] === 'assets') {
    const projectId = Number(parts[2]);
    const project = getAccessibleProject(req, res, auth, projectId, true);
    if (!project) return;
    const kind = String(url.searchParams.get('kind') || '');
    if (!ASSET_KINDS.has(kind)) return fail(res, 400, 'Loại file không hợp lệ.');
    const sceneIdRaw = url.searchParams.get('sceneId');
    const sceneId = sceneIdRaw ? Number(sceneIdRaw) : null;
    let scene = null;
    if (sceneId) {
      scene = getScene(sceneId);
      if (!scene || scene.project_id !== projectId) return fail(res, 400, 'Phân cảnh không thuộc dự án này.');
    }
    if (['ref_image', 'scene_clip', 'audio'].includes(kind) && !scene) return fail(res, 400, 'Loại file này cần gắn với một phân cảnh.');
    const contentType = String(req.headers['content-type'] || '');
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    if (!contentType.startsWith('multipart/form-data') || !boundaryMatch) {
      return fail(res, 400, 'Hãy gửi file bằng multipart/form-data.');
    }
    const raw = await readRaw(req, MAX_UPLOAD_BYTES);
    const parsed = parseMultipart(raw, boundaryMatch[1] || boundaryMatch[2]);
    const file = parsed.files.find((item) => item.field === 'file') || parsed.files[0];
    if (!file || !file.data.length) return fail(res, 400, 'Chưa nhận được file.');
    const safeExt = path.extname(file.filename).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12) || '.bin';
    const storageRelative = path.join(String(project.owner_id), String(projectId), `${kind}-${crypto.randomUUID()}${safeExt}`);
    const storageAbsolute = path.join(MEDIA_DIR, storageRelative);
    fs.mkdirSync(path.dirname(storageAbsolute), { recursive: true });
    fs.writeFileSync(storageAbsolute, file.data);
    const sha256 = crypto.createHash('sha256').update(file.data).digest('hex');
    const timestamp = now();
    const info = db.prepare(`
      INSERT INTO assets (owner_id, project_id, scene_id, kind, original_name, storage_path, mime_type, size_bytes, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(project.owner_id, projectId, sceneId, kind, cleanText(file.filename, 250), storageRelative, file.mimeType, file.data.length, sha256, timestamp);
    const assetId = Number(info.lastInsertRowid);
    if (kind === 'source_image') {
      db.prepare('UPDATE projects SET source_asset_id = ?, updated_at = ? WHERE id = ?').run(assetId, timestamp, projectId);
    } else if (kind === 'final_video') {
      db.prepare('UPDATE projects SET final_asset_id = ?, status = ?, updated_at = ? WHERE id = ?').run(assetId, 'completed', timestamp, projectId);
    } else if (scene && kind === 'ref_image') {
      db.prepare('UPDATE scenes SET ref_asset_id = ?, updated_at = ? WHERE id = ?').run(assetId, timestamp, scene.id);
    } else if (scene && kind === 'scene_clip') {
      db.prepare('UPDATE scenes SET video_asset_id = ?, review_status = ?, reviewed_at = NULL, updated_at = ? WHERE id = ?')
        .run(assetId, 'pending', timestamp, scene.id);
    } else if (scene && kind === 'audio') {
      db.prepare('UPDATE scenes SET audio_asset_id = ?, audio_voice_id = ?, voice_sync_status = ?, updated_at = ? WHERE id = ?')
        .run(assetId, project.voice_id, 'synced', timestamp, scene.id);
    }
    audit(auth.user.id, 'upload_asset', 'asset', assetId, { kind, projectId, sceneId, size: file.data.length });
    return json(res, 201, { ok: true, asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) });
  }

  if (method === 'GET' && parts[1] === 'assets' && parts[2] && parts[3] === 'content') {
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(parts[2]));
    if (!asset) return fail(res, 404, 'Không tìm thấy file.');
    let allowed = auth.user.role === 'admin' || asset.owner_id === auth.user.id;
    if (asset.project_id) {
      const project = getProjectRow(asset.project_id);
      allowed = canReadProject(auth.user, project);
    }
    if (!allowed) return fail(res, 404, 'Không tìm thấy file.');
    const absolute = path.resolve(MEDIA_DIR, asset.storage_path);
    if (!absolute.startsWith(path.resolve(MEDIA_DIR) + path.sep) || !fs.existsSync(absolute)) {
      return fail(res, 404, 'File không còn trên máy chủ.');
    }
    const stat = fs.statSync(absolute);
    const download = url.searchParams.get('download') === '1';
    const headers = {
      'Content-Type': asset.mime_type || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(asset.original_name)}`,
      'Cache-Control': 'private, max-age=60'
    };
    const range = req.headers.range;
    if (range) {
      const match = String(range).match(/bytes=(\d*)-(\d*)/);
      if (match) {
        let start = match[1] ? Number(match[1]) : 0;
        let end = match[2] ? Number(match[2]) : stat.size - 1;
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size) {
          end = Math.min(end, stat.size - 1);
          res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
          fs.createReadStream(absolute, { start, end }).pipe(res);
          return;
        }
      }
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    fs.createReadStream(absolute).pipe(res);
    return;
  }

  if (method === 'POST' && url.pathname === '/api/projects/parse-storyboard') {
    if (!requireWrite(res, auth)) return;
    const body = await readJson(req);
    const title = cleanText(body.title, 250);
    const storyboardText = String(body.storyboardText || '');
    if (!title || !storyboardText.trim()) return fail(res, 400, 'Cần nhập tên dự án và nội dung kịch bản phân cảnh.');
    const parsed = parseStoryboard(storyboardText);
    if (!parsed.length) return fail(res, 400, 'Không tách được phân cảnh nào từ kịch bản.');
    const voiceId = VOICES[body.voiceId] ? body.voiceId : 'lily';
    const timestamp = now();
    const total = parsed.reduce((sum, scene) => sum + scene.durationSec, 0);
    const info = db.prepare(`
      INSERT INTO projects (owner_id, title, source_mode, format, target_duration_sec, style, camera_style,
        voice_id, voice_label, voice_engine_id, fidelity_mode, music_enabled, music_volume, transition_sec, status, created_at, updated_at)
      VALUES (?, ?, 'storyboard', ?, ?, ?, 'auto', ?, ?, ?, 'strict100', 1, 0.28, 0.5, 'draft', ?, ?)
    `).run(auth.user.id, title, PROJECT_FORMATS.has(body.format) ? body.format : '16:9', Math.round(total),
      cleanText(body.style || 'commercial', 80), voiceId, VOICES[voiceId].label, VOICES[voiceId].engineId, timestamp, timestamp);
    const projectId = Number(info.lastInsertRowid);
    const insert = db.prepare(`
      INSERT INTO scenes (project_id, position, title, duration_sec, prompt, ref_prompt, voiceover, overlay, camera_move, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '', ?, ?, 'auto', ?, ?)
    `);
    parsed.forEach((scene, index) => insert.run(projectId, index, scene.title, scene.durationSec, scene.prompt, scene.voiceover, scene.overlay, timestamp, timestamp));
    audit(auth.user.id, 'parse_storyboard', 'project', projectId, { scenes: parsed.length });
    return json(res, 201, { ok: true, project: projectRow(getProjectRow(projectId)), sceneCount: parsed.length });
  }

  if (method === 'DELETE' && parts[1] === 'projects' && parts[2] && parts.length === 3) {
    const projectId = Number(parts[2]);
    const project = getAccessibleProject(req, res, auth, projectId, true);
    if (!project) return;
    const assets = db.prepare('SELECT storage_path FROM assets WHERE project_id = ?').all(projectId);
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    for (const asset of assets) {
      try { fs.rmSync(path.join(MEDIA_DIR, asset.storage_path), { force: true }); } catch {}
    }
    audit(auth.user.id, 'delete_project', 'project', projectId, { title: project.title });
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && parts[1] === 'projects' && parts[2] && parts[3] === 'move-scene') {
    const projectId = Number(parts[2]);
    const project = getAccessibleProject(req, res, auth, projectId, true);
    if (!project) return;
    const body = await readJson(req);
    const scenes = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY position ASC, id ASC').all(projectId);
    const index = scenes.findIndex((scene) => scene.id === Number(body.sceneId));
    const target = body.direction === 'up' ? index - 1 : index + 1;
    if (index === -1 || target < 0 || target >= scenes.length) return fail(res, 400, 'Không thể di chuyển cảnh theo hướng đó.');
    const a = scenes[index];
    const b = scenes[target];
    db.prepare('UPDATE scenes SET position = ? WHERE id = ?').run(b.position, a.id);
    db.prepare('UPDATE scenes SET position = ? WHERE id = ?').run(a.position, b.id);
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && parts[1] === 'projects' && parts[2] && parts[3] === 'scale-durations') {
    const projectId = Number(parts[2]);
    const project = getAccessibleProject(req, res, auth, projectId, true);
    if (!project) return;
    const body = await readJson(req);
    const target = clampNumber(body.targetDurationSec, 5, 600, project.target_duration_sec);
    const scenes = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY position ASC, id ASC').all(projectId);
    if (!scenes.length) return fail(res, 400, 'Dự án chưa có phân cảnh.');
    const total = scenes.reduce((sum, scene) => sum + Number(scene.duration_sec), 0) || scenes.length;
    const scaled = scenes.map((scene) => Math.max(1, Math.round((Number(scene.duration_sec) / total) * target * 2) / 2));
    let diff = Math.round((target - scaled.reduce((a, b) => a + b, 0)) * 2) / 2;
    if (diff !== 0) {
      const largest = scaled.indexOf(Math.max(...scaled));
      scaled[largest] = Math.max(1, scaled[largest] + diff);
    }
    scenes.forEach((scene, i) => db.prepare('UPDATE scenes SET duration_sec = ?, updated_at = ? WHERE id = ?').run(scaled[i], now(), scene.id));
    db.prepare('UPDATE projects SET target_duration_sec = ?, updated_at = ? WHERE id = ?').run(Math.round(target), now(), projectId);
    return json(res, 200, { ok: true, durations: scaled });
  }

  if (method === 'GET' && url.pathname === '/api/music-assets') {
    const rows = auth.user.role === 'admin'
      ? db.prepare('SELECT * FROM assets WHERE kind = ? ORDER BY created_at DESC').all('music')
      : db.prepare('SELECT * FROM assets WHERE kind = ? AND owner_id = ? ORDER BY created_at DESC').all('music', auth.user.id);
    return json(res, 200, { ok: true, musicAssets: rows });
  }

  if (method === 'POST' && url.pathname === '/api/music-assets/upload') {
    if (!requireWrite(res, auth)) return;
    const contentType = String(req.headers['content-type'] || '');
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    if (!contentType.startsWith('multipart/form-data') || !boundaryMatch) return fail(res, 400, 'Hãy gửi file bằng multipart/form-data.');
    const raw = await readRaw(req, MAX_UPLOAD_BYTES);
    const parsed = parseMultipart(raw, boundaryMatch[1] || boundaryMatch[2]);
    const file = parsed.files.find((item) => item.field === 'file') || parsed.files[0];
    if (!file || !file.data.length) return fail(res, 400, 'Chưa nhận được file nhạc.');
    const safeExt = path.extname(file.filename).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12) || '.bin';
    const storageRelative = path.join(String(auth.user.id), 'music', `music-${crypto.randomUUID()}${safeExt}`);
    const storageAbsolute = path.join(MEDIA_DIR, storageRelative);
    fs.mkdirSync(path.dirname(storageAbsolute), { recursive: true });
    fs.writeFileSync(storageAbsolute, file.data);
    const info = db.prepare(`
      INSERT INTO assets (owner_id, project_id, scene_id, kind, original_name, storage_path, mime_type, size_bytes, sha256, created_at)
      VALUES (?, NULL, NULL, 'music', ?, ?, ?, ?, ?, ?)
    `).run(auth.user.id, cleanText(parsed.fields.name || file.filename, 250), storageRelative, file.mimeType, file.data.length,
      crypto.createHash('sha256').update(file.data).digest('hex'), now());
    return json(res, 201, { ok: true, asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(info.lastInsertRowid) });
  }

  if (method === 'DELETE' && parts[1] === 'music-assets' && parts[2]) {
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(parts[2]));
    if (!asset || asset.kind !== 'music' || (auth.user.role !== 'admin' && asset.owner_id !== auth.user.id)) {
      return fail(res, 404, 'Không tìm thấy bản nhạc.');
    }
    db.prepare('UPDATE projects SET music_asset_id = NULL WHERE music_asset_id = ?').run(asset.id);
    db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
    try { fs.rmSync(path.join(MEDIA_DIR, asset.storage_path), { force: true }); } catch {}
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && parts[1] === 'scenes' && parts[2] && parts[3] === 'reference') {
    const scene = getScene(Number(parts[2]));
    if (!scene) return fail(res, 404, 'Không tìm thấy phân cảnh.');
    const project = getAccessibleProject(req, res, auth, scene.project_id, true);
    if (!project) return;
    const body = await readJson(req);
    const mode = ['exact', 'ai', 'fix'].includes(body.mode) ? body.mode : 'ai';
    if (mode === 'exact') {
      if (!project.source_asset_id) return fail(res, 400, 'Dự án chưa có ảnh gốc để dùng làm tham chiếu 100%.');
      const source = db.prepare('SELECT * FROM assets WHERE id = ?').get(project.source_asset_id);
      if (!source) return fail(res, 400, 'Không tìm thấy file ảnh gốc.');
      const safeExt = path.extname(source.original_name).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12) || '.jpg';
      const storageRelative = path.join(String(project.owner_id), String(project.id), `ref_image-${crypto.randomUUID()}${safeExt}`);
      const storageAbsolute = path.join(MEDIA_DIR, storageRelative);
      fs.mkdirSync(path.dirname(storageAbsolute), { recursive: true });
      fs.copyFileSync(path.join(MEDIA_DIR, source.storage_path), storageAbsolute);
      const data = fs.readFileSync(storageAbsolute);
      const info = db.prepare(`
        INSERT INTO assets (owner_id, project_id, scene_id, kind, original_name, storage_path, mime_type, size_bytes, sha256, created_at)
        VALUES (?, ?, ?, 'ref_image', ?, ?, ?, ?, ?, ?)
      `).run(project.owner_id, project.id, scene.id, source.original_name, storageRelative, source.mime_type, data.length,
        crypto.createHash('sha256').update(data).digest('hex'), now());
      const assetId = Number(info.lastInsertRowid);
      db.prepare('UPDATE scenes SET ref_asset_id = ?, ref_exact = 1, updated_at = ? WHERE id = ?').run(assetId, now(), scene.id);
      return json(res, 201, { ok: true, asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId), exact: true });
    }
    const instructions = mode === 'fix'
      ? 'Regenerate this scene reference from the original photo context: the product cap must be completely plain (no engraved text, no embossed or debossed logo) and every label line must be copied verbatim from the original photo — none added, none removed, none re-typeset.'
      : `Generate this scene still locked to the project master prompt and the source photo: the product must remain an exact replica — same packaging, same colors, same label text letter-for-letter; never redesign or re-typeset the label. Master prompt: ${project.master_prompt || project.title}`;
    const timestamp = now();
    const info = db.prepare(`
      INSERT INTO jobs (owner_id, project_id, kind, scope, status, payload_json, result_json, created_at, updated_at)
      VALUES (?, ?, 'reference', ?, 'waiting_provider', ?, ?, ?, ?)
    `).run(auth.user.id, project.id, `scene:${scene.id}`, JSON.stringify({ mode, instructions }),
      JSON.stringify({ message: 'Đã vào hàng đợi tạo ảnh tham chiếu. Cần cấu hình nhà cung cấp ảnh bên ngoài.' }), timestamp, timestamp);
    return json(res, 201, { ok: true, job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(info.lastInsertRowid) });
  }

  if (method === 'GET' && parts[1] === 'jobs' && parts[2]) {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(parts[2]));
    if (!job) return fail(res, 404, 'Không tìm thấy tác vụ.');
    const project = getProjectRow(job.project_id);
    if (!canReadProject(auth.user, project)) return fail(res, 404, 'Không tìm thấy tác vụ.');
    return json(res, 200, { ok: true, job });
  }

  return fail(res, 404, 'Không tìm thấy API.');
}

function serveStatic(req, res, url) {
  const routes = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8']
  };
  const route = routes[url.pathname];
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Không tìm thấy trang.');
    return;
  }
  const file = path.join(PUBLIC_DIR, route[0]);
  res.writeHead(200, {
    'Content-Type': route[1],
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin'
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'seamless-video-studio-external' });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Phương thức không được hỗ trợ.');
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) return fail(res, error.status || 500, error.message || 'Máy chủ gặp lỗi.');
    res.destroy(error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Seamless Video Studio external app listening on http://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

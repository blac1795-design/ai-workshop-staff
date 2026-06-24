const express = require('express');
const multer = require('multer');
const path = require('path');
const { load, save, newId, ensureTeamState, logHistory, supabase, BUCKET } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Supabase Storage에 파일을 업로드하고 공개 URL을 반환한다
async function uploadFile(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const filename = `${newId('f')}${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(filename, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: false
    });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(filename);
  return data.publicUrl;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
// 완료(성공)한 랜덤 미션 목록. 진행도 초기화(progress_reset) 이후의 기록만 포함한다.
function getCompletedMissions(state) {
  const history = state.history || [];
  let startIdx = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].event === 'progress_reset') { startIdx = i + 1; break; }
  }
  return history.slice(startIdx)
    .filter((h) => h.event === 'mission_approved' && h.detail && h.detail.mission)
    .map((h) => ({
      title: h.detail.mission.title,
      description: h.detail.mission.description,
      source: h.detail.mission.source,
      successCount: h.detail.successCount,
      approvedAt: h.at,
      submission: h.detail.submission || null
    }));
}

function summarizeState(state) {
  return {
    teamFinding: state.teamFinding || { status: 'none', submission: null },
    missionStatus: state.missionStatus,
    currentMission: state.currentMission,
    submission: state.submission,
    successCount: state.successCount,
    redrawUsed: state.redrawUsed,
    hintsCollected: state.hintsCollected,
    missionCount: state.assignedMissionIds.length,
    completedMissions: getCompletedMissions(state),
    finished: state.finished,
    pendingRejection: (state.lastRejection && !state.lastRejection.acknowledged) ? state.lastRejection : null,
    pendingSkip: (state.lastSkip && !state.lastSkip.acknowledged) ? state.lastSkip : null,
    destinationGuesses: state.destinationGuesses || [],
    destinationCorrect: state.destinationCorrect || false
  };
}

function pickPoolForNextMission(db, state) {
  const nextStep = state.assignedMissionIds.length; // 0-indexed slot about to be filled
  if (nextStep === 0) return { key: 'firstMissionPool', source: 'first' };
  if (nextStep === 1) return { key: 'lunchMissionPool', source: 'lunch' };
  if (nextStep === 2) return { key: 'thirdMissionPool', source: 'third' };
  return { key: 'missionPool', source: 'random' };
}

// ---------------------------------------------------------------------------
// admin auth
// ---------------------------------------------------------------------------
async function requireAdmin(req, res, next) {
  try {
    const db = await load();
    const pw = req.header('x-admin-password');
    if (!pw || pw !== db.config.adminPassword) {
      return res.status(401).json({ error: '관리자 인증이 필요합니다' });
    }
    // 신규 풀 필드 없으면 초기화 (기존 DB 하위 호환)
    if (!db.firstMissionPool) db.firstMissionPool = [];
    if (!db.thirdMissionPool) db.thirdMissionPool = [];
    req.db = db;
    next();
  } catch (e) {
    res.status(500).json({ error: '서버 오류: ' + e.message });
  }
}

app.post('/api/admin/login', async (req, res) => {
  try {
    const db = await load();
    if (req.body && req.body.password === db.config.adminPassword) {
      return res.json({ ok: true });
    }
    res.status(401).json({ error: '비밀번호가 올바르지 않습니다' });
  } catch (e) {
    res.status(500).json({ error: '서버 오류: ' + e.message });
  }
});

app.put('/api/admin/password', requireAdmin, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: '새 비밀번호를 입력하세요' });
  req.db.config.adminPassword = newPassword;
  await save(req.db);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// teams
// ---------------------------------------------------------------------------
app.get('/api/admin/teams', requireAdmin, async (req, res) => {
  const db = req.db;
  let changed = false;
  const teams = db.teams.map((t) => {
    const members = db.participants.filter((p) => p.team === t);
    if (!db.teamStates[t]) changed = true;
    const state = ensureTeamState(db, t);
    return {
      name: t,
      memberCount: members.length,
      leaderCount: members.filter((m) => m.isLeader).length,
      members: members.map((m) => ({ id: m.id, name: m.name, isLeader: m.isLeader })),
      state: summarizeState(state)
    };
  });
  if (changed) await save(db);
  res.json(teams);
});

app.post('/api/admin/teams', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '조 이름을 입력하세요' });
  if (req.db.teams.includes(name)) return res.status(400).json({ error: '이미 존재하는 조입니다' });
  req.db.teams.push(name.trim());
  ensureTeamState(req.db, name.trim());
  await save(req.db);
  res.json({ ok: true });
});

app.put('/api/admin/teams/:name', requireAdmin, async (req, res) => {
  const oldName = decodeURIComponent(req.params.name);
  const { name: newName } = req.body;
  if (!newName || !newName.trim()) return res.status(400).json({ error: '새 조 이름을 입력하세요' });
  const trimmed = newName.trim();
  if (!req.db.teams.includes(oldName)) return res.status(404).json({ error: '조를 찾을 수 없습니다' });
  if (trimmed !== oldName && req.db.teams.includes(trimmed)) return res.status(400).json({ error: '이미 존재하는 조 이름입니다' });

  const idx = req.db.teams.indexOf(oldName);
  req.db.teams[idx] = trimmed;

  if (req.db.teamStates[oldName]) {
    req.db.teamStates[trimmed] = req.db.teamStates[oldName];
    delete req.db.teamStates[oldName];
  }

  req.db.participants.forEach((p) => { if (p.team === oldName) p.team = trimmed; });
  (req.db.hintLog || []).forEach((entry) => { if (entry.team === oldName) entry.team = trimmed; });

  await save(req.db);
  res.json({ ok: true, name: trimmed });
});

app.delete('/api/admin/teams/:name', requireAdmin, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  req.db.teams = req.db.teams.filter((t) => t !== name);
  req.db.participants.forEach((p) => {
    if (p.team === name) p.team = '';
  });
  delete req.db.teamStates[name];
  await save(req.db);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// participants
// ---------------------------------------------------------------------------
app.get('/api/admin/participants', requireAdmin, async (req, res) => {
  res.json(req.db.participants);
});

app.post('/api/admin/participants', requireAdmin, async (req, res) => {
  const { name, code, team, isLeader } = req.body;
  if (!name || !code || !team) return res.status(400).json({ error: '이름, 부여코드, 소속 조는 필수입니다' });
  const p = { id: newId('p'), name: name.trim(), code: String(code).trim(), team, isLeader: !!isLeader };
  req.db.participants.push(p);
  ensureTeamState(req.db, team);
  await save(req.db);
  res.json(p);
});

app.put('/api/admin/participants/:id', requireAdmin, async (req, res) => {
  const p = req.db.participants.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '참여자를 찾을 수 없습니다' });
  const { name, code, team, isLeader } = req.body;
  if (name !== undefined) p.name = name.trim();
  if (code !== undefined) p.code = String(code).trim();
  if (team !== undefined) {
    p.team = team;
    ensureTeamState(req.db, team);
  }
  if (isLeader !== undefined) p.isLeader = !!isLeader;
  await save(req.db);
  res.json(p);
});

app.delete('/api/admin/participants/:id', requireAdmin, async (req, res) => {
  req.db.participants = req.db.participants.filter((x) => x.id !== req.params.id);
  await save(req.db);
  res.json({ ok: true });
});

app.post('/api/admin/participants/bulk-delete', requireAdmin, async (req, res) => {
  const ids = req.body.ids || [];
  req.db.participants = req.db.participants.filter((x) => !ids.includes(x.id));
  await save(req.db);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// mission pools (random / lunch)
// ---------------------------------------------------------------------------
function poolRoutes(poolKey, basePath) {
  app.get(basePath, requireAdmin, async (req, res) => res.json(req.db[poolKey]));

  // image upload endpoint for this pool
  app.post(`${basePath}/upload`, requireAdmin, upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '이미지 파일을 선택하세요' });
    try {
      const url = await uploadFile(req.file);
      res.json({ url });
    } catch (e) {
      res.status(500).json({ error: '업로드 실패: ' + e.message });
    }
  });

  app.post(basePath, requireAdmin, async (req, res) => {
    const { title, description, image } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: '미션 제목을 입력하세요' });
    const item = { id: newId('m'), title: title.trim(), description: description || '', image: image || null };
    req.db[poolKey].push(item);
    await save(req.db);
    res.json(item);
  });

  app.put(`${basePath}/:id`, requireAdmin, async (req, res) => {
    const item = req.db[poolKey].find((x) => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: '미션을 찾을 수 없습니다' });
    const { title, description, image } = req.body;
    if (title !== undefined) item.title = title.trim();
    if (description !== undefined) item.description = description;
    if (image !== undefined) item.image = image;
    await save(req.db);
    res.json(item);
  });

  app.delete(`${basePath}/:id`, requireAdmin, async (req, res) => {
    req.db[poolKey] = req.db[poolKey].filter((x) => x.id !== req.params.id);
    await save(req.db);
    res.json({ ok: true });
  });
}
poolRoutes('missionPool', '/api/admin/missions');
poolRoutes('lunchMissionPool', '/api/admin/lunch-missions');
poolRoutes('firstMissionPool', '/api/admin/first-missions');
poolRoutes('thirdMissionPool', '/api/admin/third-missions');

// ---------------------------------------------------------------------------
// hint pool
// ---------------------------------------------------------------------------
app.get('/api/admin/hints', requireAdmin, async (req, res) => res.json(req.db.hintPool));

// upload an image to attach to a hint (returns URL to use with POST/PUT below)
app.post('/api/admin/hints/upload', requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '이미지 파일을 선택하세요' });
  try {
    const url = await uploadFile(req.file);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: '업로드 실패: ' + e.message });
  }
});

app.post('/api/admin/hints', requireAdmin, async (req, res) => {
  const { content, image } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: '힌트 내용을 입력하세요' });
  const item = { id: newId('h'), content: content.trim(), image: image || null };
  req.db.hintPool.push(item);
  await save(req.db);
  res.json(item);
});

app.put('/api/admin/hints/:id', requireAdmin, async (req, res) => {
  const item = req.db.hintPool.find((x) => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '힌트를 찾을 수 없습니다' });
  const { content, image } = req.body;
  if (content !== undefined) item.content = content.trim();
  if (image !== undefined) item.image = image || null;
  await save(req.db);
  res.json(item);
});

app.delete('/api/admin/hints/:id', requireAdmin, async (req, res) => {
  req.db.hintPool = req.db.hintPool.filter((x) => x.id !== req.params.id);
  req.db.config.autoHintRules = req.db.config.autoHintRules.filter((r) => r.hintId !== req.params.id);
  await save(req.db);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// destination answers (종착지 정답 복수)
// ---------------------------------------------------------------------------
function getDestAnswers(db) {
  // 구버전(단일 문자열) 호환
  if (!db.config.destinationAnswers) {
    db.config.destinationAnswers = db.config.destinationAnswer
      ? [{ id: newId('da'), answer: db.config.destinationAnswer }]
      : [];
    db.config.destinationAnswer = undefined;
  }
  return db.config.destinationAnswers;
}

app.get('/api/admin/destination', requireAdmin, async (req, res) => {
  res.json({ answers: getDestAnswers(req.db) });
});

app.post('/api/admin/destination', requireAdmin, async (req, res) => {
  const { answer } = req.body;
  if (!answer || !answer.trim()) return res.status(400).json({ error: '정답을 입력하세요' });
  const list = getDestAnswers(req.db);
  const item = { id: newId('da'), answer: answer.trim() };
  list.push(item);
  await save(req.db);
  res.json(item);
});

app.put('/api/admin/destination/:id', requireAdmin, async (req, res) => {
  const list = getDestAnswers(req.db);
  const item = list.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '항목을 찾을 수 없습니다' });
  const { answer } = req.body;
  if (!answer || !answer.trim()) return res.status(400).json({ error: '정답을 입력하세요' });
  item.answer = answer.trim();
  await save(req.db);
  res.json(item);
});

app.delete('/api/admin/destination/:id', requireAdmin, async (req, res) => {
  const list = getDestAnswers(req.db);
  req.db.config.destinationAnswers = list.filter(x => x.id !== req.params.id);
  await save(req.db);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// auto hint rules
// ---------------------------------------------------------------------------
app.get('/api/admin/auto-hint-rules', requireAdmin, async (req, res) => res.json(req.db.config.autoHintRules));

app.post('/api/admin/auto-hint-rules', requireAdmin, async (req, res) => {
  const { afterSuccessCount, hintId } = req.body;
  const n = Number(afterSuccessCount);
  if (!n || n <= 0) return res.status(400).json({ error: '성공 횟수(N)를 1 이상으로 입력하세요' });
  const hint = req.db.hintPool.find((h) => h.id === hintId);
  if (!hint) return res.status(400).json({ error: '존재하지 않는 힌트입니다' });
  const rule = { id: newId('r'), afterSuccessCount: n, hintId };
  req.db.config.autoHintRules.push(rule);
  await save(req.db);
  res.json(rule);
});

app.delete('/api/admin/auto-hint-rules/:id', requireAdmin, async (req, res) => {
  req.db.config.autoHintRules = req.db.config.autoHintRules.filter((r) => r.id !== req.params.id);
  await save(req.db);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// monitoring / approval
// ---------------------------------------------------------------------------
app.get('/api/admin/progress', requireAdmin, async (req, res) => {
  const db = req.db;
  let changed = false;
  const result = db.teams.map((t) => {
    if (!db.teamStates[t]) changed = true;
    const state = ensureTeamState(db, t);
    return { team: t, ...summarizeState(state) };
  });
  if (changed) await save(db);
  res.json(result);
});

app.get('/api/admin/teams/:team/state', requireAdmin, async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const state = ensureTeamState(req.db, team);
  await save(req.db);
  res.json(state);
});

app.post('/api/admin/teams/:team/approve', requireAdmin, async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const db = req.db;
  const state = ensureTeamState(db, team);
  if (state.missionStatus !== 'pending') {
    return res.status(400).json({ error: '승인 대기 중인 제출물이 없습니다' });
  }

  state.successCount += 1;
  logHistory(state, 'mission_approved', { mission: state.currentMission, submission: state.submission, successCount: state.successCount });

  // random hint from pool (avoid duplicates already collected, and hints reserved for auto-dispatch rules)
  const collectedIds = state.hintsCollected.map((h) => h.id);
  const autoRuleHintIds = (db.config.autoHintRules || []).map((r) => r.hintId);
  const availableHints = db.hintPool.filter((h) => !collectedIds.includes(h.id) && !autoRuleHintIds.includes(h.id));
  let grantedHint = null;
  if (availableHints.length > 0) {
    grantedHint = availableHints[Math.floor(Math.random() * availableHints.length)];
    state.hintsCollected.push({
      id: grantedHint.id,
      content: grantedHint.content,
      image: grantedHint.image || null,
      type: 'random',
      receivedAt: new Date().toISOString()
    });
    db.hintLog.push({ team, hintId: grantedHint.id, type: 'random', sentAt: new Date().toISOString() });
  }

  // auto-dispatch hints based on success-count rules
  const newCollectedIds = state.hintsCollected.map((h) => h.id);
  (db.config.autoHintRules || []).forEach((rule) => {
    if (rule.afterSuccessCount === state.successCount && !state.autoHintsSent.includes(rule.id)) {
      const hint = db.hintPool.find((h) => h.id === rule.hintId);
      if (hint && !newCollectedIds.includes(hint.id)) {
        state.hintsCollected.push({
          id: hint.id,
          content: hint.content,
          image: hint.image || null,
          type: 'auto',
          receivedAt: new Date().toISOString()
        });
        db.hintLog.push({ team, hintId: hint.id, type: 'auto', sentAt: new Date().toISOString() });
        newCollectedIds.push(hint.id);
      }
      state.autoHintsSent.push(rule.id);
    }
  });

  // reset for next mission
  state.missionStatus = 'none';
  state.currentMission = null;
  state.submission = null;

  await save(db);
  res.json({ ok: true, grantedHint, successCount: state.successCount, hintsCollected: state.hintsCollected });
});

app.post('/api/admin/teams/:team/reject', requireAdmin, async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const state = ensureTeamState(req.db, team);
  if (state.missionStatus !== 'pending') {
    return res.status(400).json({ error: '승인 대기 중인 제출물이 없습니다' });
  }
  state.missionStatus = 'assigned';
  state.lastRejection = { note: req.body.note || '', at: new Date().toISOString(), acknowledged: false };
  logHistory(state, 'mission_rejected', { mission: state.currentMission, note: req.body.note || '' });
  await save(req.db);
  res.json({ ok: true });
});

// 미션 실패/넘어가기: 성공 횟수, 힌트, 종착지 추측 기회를 늘리지 않고 다음 미션으로 진행
app.post('/api/admin/teams/:team/skip', requireAdmin, async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const db = req.db;
  const state = ensureTeamState(db, team);
  if (state.missionStatus !== 'pending' && state.missionStatus !== 'assigned') {
    return res.status(400).json({ error: '넘어갈 수 있는 미션이 없습니다' });
  }

  logHistory(state, 'mission_skipped', { mission: state.currentMission, submission: state.submission });

  state.missionStatus = 'none';
  state.currentMission = null;
  state.submission = null;
  state.lastRejection = null;
  state.lastSkip = { at: new Date().toISOString(), acknowledged: false };

  await save(db);
  res.json({ ok: true });
});

// 랜덤 미션 진행도 초기화 (2단계 이후 진행상황을 처음 상태로 되돌림. 0단계 조원 찾기 상태는 유지)
app.post('/api/admin/teams/:team/progress/reset', requireAdmin, async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const db = req.db;
  const state = ensureTeamState(db, team);

  state.assignedMissionIds = [];
  state.redrawUsed = false;
  state.currentMission = null;
  state.missionStatus = 'none';
  state.submission = null;
  state.successCount = 0;
  state.hintsCollected = [];
  state.autoHintsSent = [];
  state.destinationGuesses = [];
  state.destinationCorrect = false;
  state.finished = false;
  logHistory(state, 'progress_reset', {});

  await save(db);
  res.json({ ok: true });
});

// 0단계: 조원 찾기 인증 사진 승인/반려
app.post('/api/admin/teams/:team/teamfinding/approve', requireAdmin, async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const state = ensureTeamState(req.db, team);
  if (state.teamFinding.status !== 'pending') {
    return res.status(400).json({ error: '승인 대기 중인 제출물이 없습니다' });
  }
  state.teamFinding.status = 'approved';
  logHistory(state, 'teamfinding_approved', state.teamFinding.submission);
  await save(req.db);
  res.json({ ok: true });
});

app.post('/api/admin/teams/:team/teamfinding/reject', requireAdmin, async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const state = ensureTeamState(req.db, team);
  if (state.teamFinding.status !== 'pending') {
    return res.status(400).json({ error: '승인 대기 중인 제출물이 없습니다' });
  }
  state.teamFinding.status = 'none';
  state.teamFinding.rejectionNote = req.body.note || '';
  logHistory(state, 'teamfinding_rejected', { note: req.body.note || '' });
  await save(req.db);
  res.json({ ok: true });
});

// reset team-finding (0단계) back to 'none' so the team can resubmit
app.post('/api/admin/teams/:team/teamfinding/reset', requireAdmin, async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const state = ensureTeamState(req.db, team);
  state.teamFinding = { status: 'none', submission: null };
  logHistory(state, 'teamfinding_reset', {});
  await save(req.db);
  res.json({ ok: true });
});

app.get('/api/admin/hint-log', requireAdmin, async (req, res) => res.json(req.db.hintLog));

// ---------------------------------------------------------------------------
// participant / leader endpoints
// ---------------------------------------------------------------------------

// Step 1: find my team
app.post('/api/team-lookup', async (req, res) => {
  const db = await load();
  const { name, code } = req.body;
  if (!name || !code) return res.status(400).json({ error: '이름과 부여코드를 입력하세요' });
  const p = db.participants.find(
    (x) => x.name === String(name).trim() && x.code === String(code).trim()
  );
  if (!p) return res.status(404).json({ error: '일치하는 참여자를 찾을 수 없습니다. 이름과 부여코드를 다시 확인해주세요.' });
  res.json({ team: p.team, isLeader: !!p.isLeader, name: p.name });
});

// current team state (for leader UI)
app.get('/api/team/:team/state', async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const db = await load();
  if (!db.teams.includes(team)) return res.status(404).json({ error: '존재하지 않는 조입니다' });
  const state = ensureTeamState(db, team);
  await save(db);
  res.json(summarizeState(state));
});

// 0단계: 조원 찾기 인증 사진/영상 제출
app.post('/api/team/:team/teamfinding/submit', upload.single('media'), async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const db = await load();
  if (!db.teams.includes(team)) return res.status(404).json({ error: '존재하지 않는 조입니다' });
  const state = ensureTeamState(db, team);

  if (state.teamFinding.status === 'approved') {
    return res.status(400).json({ error: '이미 완료된 미션입니다' });
  }

  const { link, note } = req.body;
  let submission;
  if (req.file) {
    let url;
    try {
      url = await uploadFile(req.file);
    } catch (e) {
      return res.status(500).json({ error: '업로드 실패: ' + e.message });
    }
    submission = {
      type: 'file',
      value: url,
      originalName: req.file.originalname,
      note: note || '',
      submittedAt: new Date().toISOString()
    };
  } else if (link && link.trim()) {
    submission = { type: 'link', value: link.trim(), note: note || '', submittedAt: new Date().toISOString() };
  } else {
    return res.status(400).json({ error: '사진을 업로드하거나 링크를 입력해주세요' });
  }

  state.teamFinding.submission = submission;
  state.teamFinding.status = 'pending';
  logHistory(state, 'teamfinding_submitted', submission);
  await save(db);

  res.json({ ok: true, teamFinding: state.teamFinding });
});

// assign a new random mission (2nd mission always from lunch pool)
app.post('/api/team/:team/mission/assign', async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const db = await load();
  if (!db.teams.includes(team)) return res.status(404).json({ error: '존재하지 않는 조입니다' });
  const state = ensureTeamState(db, team);

  if (state.missionStatus === 'assigned' || state.missionStatus === 'pending') {
    return res.status(400).json({
      error: '이미 진행중인 미션이 있습니다',
      mission: state.currentMission,
      missionStatus: state.missionStatus
    });
  }

  if (!db.firstMissionPool) db.firstMissionPool = [];
  if (!db.thirdMissionPool) db.thirdMissionPool = [];
  const { key, source } = pickPoolForNextMission(db, state);
  const pool = db[key] || [];
  const available = pool.filter((m) => !state.assignedMissionIds.includes(m.id));
  if (available.length === 0) {
    return res.status(400).json({ error: '배정 가능한 미션이 더 이상 없습니다. 관리자에게 문의하세요.' });
  }

  const mission = available[Math.floor(Math.random() * available.length)];
  state.currentMission = { id: mission.id, title: mission.title, description: mission.description, source };
  state.assignedMissionIds.push(mission.id);
  state.missionStatus = 'assigned';
  state.submission = null;
  logHistory(state, 'mission_assigned', state.currentMission);
  await save(db);

  res.json({
    mission: state.currentMission,
    missionStatus: state.missionStatus,
    redrawUsed: state.redrawUsed,
    missionNumber: state.assignedMissionIds.length
  });
});

// redraw current mission (once per team for whole workshop)
app.post('/api/team/:team/mission/redraw', async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const db = await load();
  if (!db.teams.includes(team)) return res.status(404).json({ error: '존재하지 않는 조입니다' });
  const state = ensureTeamState(db, team);

  if (state.redrawUsed) return res.status(400).json({ error: '재추첨 기회를 이미 사용했습니다' });
  if (state.missionStatus !== 'assigned') return res.status(400).json({ error: '현재 재추첨할 수 있는 상태가 아닙니다' });

  const poolKey = state.currentMission.source === 'lunch' ? 'lunchMissionPool'
    : state.currentMission.source === 'first' ? 'firstMissionPool'
    : state.currentMission.source === 'third' ? 'thirdMissionPool'
    : 'missionPool';
  const pool = db[poolKey];
  const available = pool.filter((m) => !state.assignedMissionIds.includes(m.id));
  if (available.length === 0) return res.status(400).json({ error: '재추첨할 다른 미션이 없습니다' });

  const mission = available[Math.floor(Math.random() * available.length)];
  const oldId = state.currentMission.id;
  const idx = state.assignedMissionIds.lastIndexOf(oldId);
  if (idx >= 0) state.assignedMissionIds[idx] = mission.id;

  state.currentMission = {
    id: mission.id,
    title: mission.title,
    description: mission.description,
    source: state.currentMission.source
  };
  state.redrawUsed = true;
  state.submission = null;
  logHistory(state, 'mission_redrawn', state.currentMission);
  await save(db);

  res.json({ mission: state.currentMission, missionStatus: state.missionStatus, redrawUsed: state.redrawUsed });
});

// submit photo/video (file upload) or external link
app.post('/api/team/:team/mission/submit', upload.array('media', 3), async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const db = await load();
  if (!db.teams.includes(team)) return res.status(404).json({ error: '존재하지 않는 조입니다' });
  const state = ensureTeamState(db, team);

  if (state.missionStatus !== 'assigned') {
    return res.status(400).json({ error: '제출할 수 있는 미션이 없습니다' });
  }

  const { link, note } = req.body;
  let files;
  try {
    files = await Promise.all((req.files || []).map(async (f) => ({
      value: await uploadFile(f),
      originalName: f.originalname
    })));
  } catch (e) {
    return res.status(500).json({ error: '업로드 실패: ' + e.message });
  }
  const trimmedLink = (link || '').trim();
  const trimmedNote = (note || '').trim();

  if (files.length === 0 && !trimmedLink && !trimmedNote) {
    return res.status(400).json({ error: '사진/동영상 파일, 링크, 메모 중 하나 이상을 제출해주세요' });
  }

  const submission = {
    type: files.length ? 'file' : (trimmedLink ? 'link' : 'note'),
    files,
    link: trimmedLink || null,
    note: note || '',
    submittedAt: new Date().toISOString()
  };

  state.submission = submission;
  state.missionStatus = 'pending';
  logHistory(state, 'mission_submitted', submission);
  await save(db);

  res.json({ ok: true, missionStatus: state.missionStatus, submission });
});

// acknowledge a mission rejection (참여자가 반려 사유를 확인했음을 표시)
app.post('/api/team/:team/mission/ack-rejection', async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const db = await load();
  if (!db.teams.includes(team)) return res.status(404).json({ error: '존재하지 않는 조입니다' });
  const state = ensureTeamState(db, team);
  if (state.lastRejection) {
    state.lastRejection.acknowledged = true;
    await save(db);
  }
  res.json({ ok: true });
});

// acknowledge a mission skip (참여자가 넘어가기 안내를 확인했음을 표시)
app.post('/api/team/:team/mission/ack-skip', async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const db = await load();
  if (!db.teams.includes(team)) return res.status(404).json({ error: '존재하지 않는 조입니다' });
  const state = ensureTeamState(db, team);
  if (state.lastSkip) {
    state.lastSkip.acknowledged = true;
    await save(db);
  }
  res.json({ ok: true });
});

// destination guess (종착지 추측)
app.post('/api/team/:team/destination/guess', async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const db = await load();
  if (!db.teams.includes(team)) return res.status(404).json({ error: '존재하지 않는 조입니다' });
  const state = ensureTeamState(db, team);

  if (state.teamFinding.status !== 'approved') {
    return res.status(400).json({ error: '조원 찾기 미션을 완료해야 합니다' });
  }
  if (state.destinationCorrect) {
    return res.status(400).json({ error: '이미 정답을 맞췄습니다' });
  }

  const guessesUsed = (state.destinationGuesses || []).length;
  const remaining = state.successCount - guessesUsed;
  if (remaining <= 0) {
    return res.status(400).json({ error: '남은 추측 기회가 없습니다. 미션을 더 성공하면 기회가 생깁니다.' });
  }

  const guess = (req.body.guess || '').trim();
  if (!guess) return res.status(400).json({ error: '추측 내용을 입력하세요' });

  const answers = getDestAnswers(db);
  const correct = answers.length > 0 && answers.some(a => a.answer.toLowerCase() === guess.toLowerCase());

  if (!state.destinationGuesses) state.destinationGuesses = [];
  state.destinationGuesses.push({ guess, correct, at: new Date().toISOString() });
  if (correct) state.destinationCorrect = true;

  logHistory(state, 'destination_guess', { guess, correct });
  await save(db);

  res.json({
    correct,
    remaining: state.successCount - state.destinationGuesses.length,
    guessesUsed: state.destinationGuesses.length
  });
});

// hints collected so far
app.get('/api/team/:team/hints', async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const db = await load();
  if (!db.teams.includes(team)) return res.status(404).json({ error: '존재하지 않는 조입니다' });
  const state = ensureTeamState(db, team);
  await save(db);
  res.json({ hintsCollected: state.hintsCollected, successCount: state.successCount });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`AI 워크샵 스태프 서버 실행 중: http://localhost:${PORT}`);
    console.log(`관리자 페이지: http://localhost:${PORT}/admin.html`);
    console.log(`참여자 페이지: http://localhost:${PORT}/index.html`);
  });
}

module.exports = app;

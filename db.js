const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[db] SUPABASE_URL / SUPABASE_KEY 환경변수가 설정되지 않았습니다.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const ROW_ID = 'main';
const BUCKET = 'uploads';

async function load() {
  const { data, error } = await supabase
    .from('app_data')
    .select('data')
    .eq('id', ROW_ID)
    .single();

  if (error) throw error;
  return data.data;
}

async function save(db) {
  const { error } = await supabase
    .from('app_data')
    .upsert({ id: ROW_ID, data: db, updated_at: new Date().toISOString() });

  if (error) throw error;
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultTeamState() {
  return {
    teamFinding: { status: 'none', submission: null }, // none | pending | approved
    assignedMissionIds: [],
    redrawUsed: false,
    currentMission: null, // { id, title, description, source: 'random'|'lunch' }
    missionStatus: 'none', // none | assigned | pending | approved
    submission: null, // { type: 'link'|'file', value, note, submittedAt }
    successCount: 0,
    hintsCollected: [], // [{ id, content, type: 'random'|'auto', receivedAt }]
    autoHintsSent: [], // [ruleId]
    destinationGuesses: [], // [{ guess, correct, at }]
    destinationCorrect: false,
    finished: false,
    history: [] // [{ at, event, detail }]
  };
}

function ensureTeamState(db, team) {
  if (!db.teamStates[team]) {
    db.teamStates[team] = defaultTeamState();
  }
  if (!db.teamStates[team].teamFinding) {
    db.teamStates[team].teamFinding = { status: 'none', submission: null };
  }
  return db.teamStates[team];
}

function logHistory(state, event, detail) {
  state.history.push({ at: new Date().toISOString(), event, detail: detail || null });
}

module.exports = {
  load,
  save,
  newId,
  ensureTeamState,
  defaultTeamState,
  logHistory,
  supabase,
  BUCKET
};

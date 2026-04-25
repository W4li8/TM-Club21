'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const path = require('path');
const { getState, bump, resetState } = require('./state');
const { loadQuestions, getRandomUnusedQuestion } = require('./questions');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'client')));

const USER_PASSWORD = process.env.USER_PASSWORD || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PORT = parseInt(process.env.PORT || '3000', 10);

if (!USER_PASSWORD || !ADMIN_PASSWORD) {
  console.warn('[WARNING] USER_PASSWORD or ADMIN_PASSWORD not set in .env');
}

loadQuestions();

// ── Auth helpers ────────────────────────────────────────────────────────────

function checkUser(req, res) {
  const pwd = req.headers['x-password'] || req.body?.password;
  if (pwd !== USER_PASSWORD && pwd !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Invalid password' });
    return false;
  }
  return true;
}

function checkAdmin(req, res) {
  const pwd = req.headers['x-password'] || req.body?.password;
  if (pwd !== ADMIN_PASSWORD) {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

function isAdminReq(req) {
  const pwd = req.headers['x-password'] || req.body?.password;
  return pwd === ADMIN_PASSWORD;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ role: 'admin' });
  if (password === USER_PASSWORD) return res.json({ role: 'user' });
  res.status(401).json({ error: 'Invalid password' });
});

// ── State ─────────────────────────────────────────────────────────────────────

app.get('/api/state', (req, res) => {
  if (!checkUser(req, res)) return;
  res.json(getState());
});

// ── Join / Rejoin ─────────────────────────────────────────────────────────────

app.post('/api/join', (req, res) => {
  const pwd = req.headers['x-password'] || req.body?.password;
  if (pwd !== USER_PASSWORD && pwd !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const { name, role, rejoin } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name required' });
  }

  const st = getState();
  const trimmed = name.trim();
  const existing = st.participants.find((p) => p.name === trimmed);
  const adminJoin = isAdminReq(req);

  if (existing) {
    if (!rejoin) {
      return res.status(409).json({ error: 'Name taken', canRejoin: true });
    }
    // Rejoin — restore session
    if (adminJoin && !st.adminList.includes(trimmed)) {
      st.adminList.push(trimmed);
      existing.isAdmin = true;
      bump();
    }
    return res.json({ ok: true, participant: existing, rejoined: true });
  }

  // New join
  const isAdmin = adminJoin;
  let assignedRole = role === 'competitor' ? 'competitor' : 'observer';

  // If draw locked and all slots filled, force observer
  if (st.phase !== 'registration') {
    const openSlot = st.groups.some(
      (g) => g.status === 'pending' && g.members.length < (st.settings.maxPerGroup || Infinity)
    );
    if (!openSlot) assignedRole = 'observer';
  }

  const participant = {
    name: trimmed,
    role: assignedRole,
    groupIndex: null,
    joinedAt: Date.now(),
    isAdmin,
  };
  st.participants.push(participant);

  if (isAdmin && !st.adminList.includes(trimmed)) {
    st.adminList.push(trimmed);
  }

  bump();
  res.json({ ok: true, participant, rejoined: false });
});

// ── Voting ─────────────────────────────────────────────────────────────────────

app.post('/api/vote', (req, res) => {
  if (!checkUser(req, res)) return;
  const { voterName, candidateName } = req.body;
  const st = getState();

  if (!st.voting.active) return res.status(400).json({ error: 'Voting not open' });
  if (!st.voting.eligibleVoters.includes(voterName)) {
    return res.status(403).json({ error: 'Not eligible to vote in this round' });
  }

  // Auto-close if window expired
  const elapsed = (Date.now() - st.voting.openedAt) / 1000;
  if (elapsed > st.voting.windowSeconds) {
    return res.status(400).json({ error: 'Voting window closed' });
  }

  const candidates = st.voting.eligibleVoters.length > 0
    ? Object.keys(st.voting.results || {})
    : [];

  // Derive candidates from current round contestants
  if (!st.currentSpeaker) return res.status(400).json({ error: 'No active round' });

  st.voting.votes[voterName] = candidateName;
  bump();
  res.json({ ok: true });
});

// ── Admin: Settings ───────────────────────────────────────────────────────────

app.post('/api/admin/settings', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const st = getState();
  const allowed = [
    'silenceEnd', 'greenEnd', 'yellowEnd', 'redEnd',
    'votingWindowSeconds', 'numGroups', 'maxPerGroup',
    'breakMinutes', 'stageLabels',
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      st.settings[key] = req.body[key];
    }
  }
  bump();
  res.json({ ok: true });
});

// ── Admin: Lock draw ──────────────────────────────────────────────────────────

app.post('/api/admin/lock-draw', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const st = getState();

  const competitors = st.participants.filter((p) => p.role === 'competitor');
  const n = st.settings.numGroups;
  const maxPer = st.settings.maxPerGroup || Math.ceil(competitors.length / n);
  st.settings.maxPerGroup = maxPer;

  // Shuffle
  const shuffled = [...competitors].sort(() => Math.random() - 0.5);
  const groups = [];
  for (let i = 0; i < n; i++) {
    groups.push({ id: i, members: [], performanceOrder: [], status: 'pending' });
  }
  shuffled.forEach((p, idx) => {
    const gIdx = idx % n;
    groups[gIdx].members.push(p.name);
    p.groupIndex = gIdx;
  });

  st.groups = groups;
  st.phase = 'group';
  bump();
  res.json({ ok: true, groups: st.groups });
});

// ── Admin: Assign late arrival ────────────────────────────────────────────────

app.post('/api/admin/assign-late', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { name, groupIndex } = req.body;
  const st = getState();

  const p = st.participants.find((x) => x.name === name);
  if (!p) return res.status(404).json({ error: 'Participant not found' });

  const group = st.groups[groupIndex];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.status !== 'pending') return res.status(400).json({ error: 'Group already performed' });

  p.role = 'competitor';
  p.groupIndex = groupIndex;
  if (!group.members.includes(name)) group.members.push(name);
  bump();
  res.json({ ok: true });
});

// ── Admin: Spin wheel (set performance order) ─────────────────────────────────

app.post('/api/admin/spin-wheel', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { groupId } = req.body;
  const st = getState();

  const group = st.groups.find((g) => g.id === groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const shuffled = [...group.members].sort(() => Math.random() - 0.5);
  group.performanceOrder = shuffled;
  bump();
  res.json({ ok: true, performanceOrder: shuffled });
});

// ── Admin: Draw question ──────────────────────────────────────────────────────

app.post('/api/admin/draw-question', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const st = getState();

  const stageMap = {
    group: 'group_stage',
    quarter_debate: 'quarter_debate',
    semi_final: 'semi_final',
    final: 'final',
  };
  const stageName = stageMap[st.phase];
  if (!stageName) return res.status(400).json({ error: 'Invalid phase for question draw' });

  const used = st.usedQuestions[stageName] || [];
  const q = getRandomUnusedQuestion(stageName, used);
  if (!q) return res.status(400).json({ error: 'No questions remaining for this stage' });

  st.usedQuestions[stageName].push(q.text);
  st.currentQuestion = { stage: stageName, theme: q.theme, text: q.text };
  bump();
  res.json({ ok: true, question: st.currentQuestion });
});

// ── Admin: Timer controls ─────────────────────────────────────────────────────

app.post('/api/admin/timer', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { action, speakerName, groupId } = req.body;
  const st = getState();

  if (action === 'start') {
    if (!st.currentSpeaker) {
      st.currentSpeaker = { name: speakerName, groupId, startTime: Date.now(), timerState: 'running' };
    } else {
      st.currentSpeaker.startTime = Date.now();
      st.currentSpeaker.timerState = 'running';
    }
  } else if (action === 'stop') {
    if (st.currentSpeaker) st.currentSpeaker.timerState = 'stopped';
  } else if (action === 'restart') {
    if (st.currentSpeaker) {
      st.currentSpeaker.startTime = Date.now();
      st.currentSpeaker.timerState = 'running';
    }
  } else if (action === 'set-speaker') {
    st.currentSpeaker = { name: speakerName, groupId, startTime: null, timerState: 'idle' };
  }

  bump();
  res.json({ ok: true, currentSpeaker: st.currentSpeaker });
});

// ── Admin: Open voting ────────────────────────────────────────────────────────

app.post('/api/admin/open-voting', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const st = getState();
  const { candidates, windowSeconds } = req.body;

  if (!candidates || !Array.isArray(candidates)) {
    return res.status(400).json({ error: 'Candidates required' });
  }

  // Eligible = all participants except current round contestants
  const eligible = st.participants
    .filter((p) => !candidates.includes(p.name))
    .map((p) => p.name);

  st.voting = {
    active: true,
    windowSeconds: windowSeconds || st.settings.votingWindowSeconds,
    openedAt: Date.now(),
    votes: {},
    eligibleVoters: eligible,
    candidates,
    results: null,
    tiebreakAdminVoteUsed: false,
  };
  bump();
  res.json({ ok: true });
});

// ── Admin: Close voting ───────────────────────────────────────────────────────

app.post('/api/admin/close-voting', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const st = getState();

  st.voting.active = false;

  // Tally
  const tally = {};
  (st.voting.candidates || []).forEach((c) => (tally[c] = 0));
  Object.values(st.voting.votes).forEach((c) => {
    if (tally[c] !== undefined) tally[c]++;
  });
  st.voting.results = tally;

  bump();
  res.json({ ok: true, results: tally });
});

// ── Admin: Tiebreak vote ──────────────────────────────────────────────────────

app.post('/api/admin/tiebreak-vote', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { adminName, candidateName } = req.body;
  const st = getState();

  if (!st.voting.results) return res.status(400).json({ error: 'No results yet' });
  if (st.voting.tiebreakAdminVoteUsed) return res.status(400).json({ error: 'Tiebreak already used' });

  // Step 1: Remove earliest-registered admin's vote from tally
  const admins = st.adminList;
  const earliestAdmin = st.participants
    .filter((p) => admins.includes(p.name))
    .sort((a, b) => a.joinedAt - b.joinedAt)[0];

  if (earliestAdmin) {
    const previousVote = st.voting.votes[earliestAdmin.name];
    if (previousVote && st.voting.results[previousVote] !== undefined) {
      st.voting.results[previousVote] = Math.max(0, st.voting.results[previousVote] - 1);
    }
    delete st.voting.votes[earliestAdmin.name];
  }

  // Recheck tie
  const max = Math.max(...Object.values(st.voting.results));
  const tied = Object.keys(st.voting.results).filter((c) => st.voting.results[c] === max);

  if (tied.length > 1) {
    // Still tied — apply override
    if (candidateName) {
      st.voting.results[candidateName] = (st.voting.results[candidateName] || 0) + 1;
      st.voting.tiebreakAdminVoteUsed = true;
    }
  }

  bump();
  res.json({ ok: true, results: st.voting.results });
});

// ── Admin: Advance phase ──────────────────────────────────────────────────────

app.post('/api/admin/advance', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { action, data } = req.body;
  const st = getState();

  if (action === 'next-speaker') {
    st.currentSpeaker = null;
    st.currentQuestion = null;
    bump();
  } else if (action === 'complete-group') {
    const { groupId, winner } = data || {};
    const group = st.groups.find((g) => g.id === groupId);
    if (group) {
      group.status = 'done';
      if (winner) st.bracket.group_winners.push(winner);
    }
    st.currentSpeaker = null;
    st.currentQuestion = null;
    bump();
  } else if (action === 'start-quarter') {
    st.phase = 'quarter_debate';
    // Randomly assign group winners into teams of ~4
    const winners = [...st.bracket.group_winners].sort(() => Math.random() - 0.5);
    const teams = [];
    while (winners.length > 0) teams.push(winners.splice(0, 4));
    st.bracket.quarter_teams = teams;
    bump();
  } else if (action === 'complete-quarter') {
    const { winner } = data || {};
    if (winner) st.bracket.semi_winners.push(winner);
    bump();
  } else if (action === 'start-semi') {
    st.phase = 'semi_final';
    bump();
  } else if (action === 'complete-semi') {
    const { winner } = data || {};
    if (winner) st.bracket.finalist = winner;
    bump();
  } else if (action === 'start-final') {
    st.phase = 'final';
    bump();
  } else if (action === 'close') {
    st.phase = 'closed';
    bump();
  } else if (action === 'reset') {
    resetState();
    loadQuestions();
    bump();
  }

  res.json({ ok: true, phase: getState().phase });
});

// ── Catch-all → client ────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[tm-olympics] Server running on port ${PORT}`);
});

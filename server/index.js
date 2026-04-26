'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const path = require('path');
const { getState, bump, resetState } = require('./state');
const { loadQuestions, getRandomUnusedQuestion, getPhases } = require('./questions');

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

function getRequester(st, req) {
  const headerName = typeof req.headers['x-name'] === 'string' ? req.headers['x-name'] : '';
  const name = headerName.trim();
  if (!name) return null;
  return st.participants.find((p) => p.name === name) || null;
}

function checkUser(req, res) {
  const st = getState();
  const requester = getRequester(st, req);
  if (requester) {
    req.requester = requester;
    return true;
  }

  const pwd = req.headers['x-password'] || req.body?.password;
  if (pwd === USER_PASSWORD || pwd === ADMIN_PASSWORD) {
    return true;
  }

  res.status(401).json({ error: 'Unknown participant. Please join first.' });
  return false;
}

function checkAdmin(req, res) {
  const st = getState();
  const requester = getRequester(st, req);
  if (requester && requester.isAdmin) {
    req.requester = requester;
    return true;
  }

  const pwd = req.headers['x-password'] || req.body?.password;
  if (pwd === ADMIN_PASSWORD) {
    return true;
  }

  res.status(403).json({ error: 'Admin access required' });
  return false;
}

function isAdminReq(req, existingParticipant) {
  if (existingParticipant && existingParticipant.isAdmin) return true;
  const st = getState();
  const requester = getRequester(st, req);
  if (requester && requester.isAdmin) return true;

  const pwd = req.headers['x-password'] || req.body?.password;
  return pwd === ADMIN_PASSWORD;
}

function requireSelf(req, res, name) {
  if (!checkUser(req, res)) return null;
  const requester = req.requester;
  if (!requester) return true;
  if (!name || requester.name !== name) {
    res.status(403).json({ error: 'Can only act as your own user' });
    return false;
  }
  return true;
}

function upsertSpeakerLogEntry(st, payload) {
  if (!payload || !payload.name) return;
  const idx = st.speakerLog.findIndex((x) => x.name === payload.name && x.phase === payload.phase);
  if (idx >= 0) st.speakerLog[idx] = { ...st.speakerLog[idx], ...payload };
  else st.speakerLog.push(payload);
}

// ── Public: known-name check & phases ────────────────────────────────────────

app.get('/api/known-name', (req, res) => {
  const name = (req.query.name || '').trim();
  const st = getState();
  const p = st.participants.find((p) => p.name === name);
  res.json({ known: !!p, isAdmin: p?.isAdmin ?? false });
});

app.get('/api/phases', (req, res) => {
  res.json(getPhases());
});

// ── State ─────────────────────────────────────────────────────────────────────

app.get('/api/state', (req, res) => {
  if (!checkUser(req, res)) return;
  res.json(getState());
});

// ── Join / Rejoin ─────────────────────────────────────────────────────────────

app.post('/api/join', (req, res) => {
  const pwd = req.headers['x-password'] || req.body?.password;
  const { name, role, rejoin } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name required' });
  }

  const st = getState();
  const trimmed = name.trim();
  const existing = st.participants.find((p) => p.name === trimmed);

  // Known participants may rejoin without re-entering the password
  const passwordOk = pwd === USER_PASSWORD || pwd === ADMIN_PASSWORD;
  if (!passwordOk && !(rejoin && existing)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const adminJoin = isAdminReq(req, existing);

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
  const requestedRole = role === 'competitor' ? 'competitor' : 'observer';
  let assignedRole = requestedRole;
  const joinedAfterRegistration = st.phase !== 'registration';
  const wantsToCompete = requestedRole === 'competitor';

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
    wantsToCompete,
    joinedAfterRegistration,
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
  const effectiveVoter = req.requester?.name || voterName;

  if (!effectiveVoter) return res.status(400).json({ error: 'Voter name required' });
  if (req.requester && voterName && voterName !== req.requester.name) {
    return res.status(403).json({ error: 'Can only vote as yourself' });
  }

  if (!st.voting.active) return res.status(400).json({ error: 'Voting not open' });
  if (!st.voting.eligibleVoters.includes(effectiveVoter)) {
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

  st.voting.votes[effectiveVoter] = candidateName;
  bump();
  res.json({ ok: true });
});

// ── Admin: Remove participant ─────────────────────────────────────────────────

app.post('/api/admin/remove-participant', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const st = getState();
  if (st.phase !== 'registration') {
    return res.status(400).json({ error: 'Can only remove participants during registration' });
  }
  const { name } = req.body;
  const idx = st.participants.findIndex((p) => p.name === name);
  if (idx === -1) return res.status(404).json({ error: 'Participant not found' });
  st.participants.splice(idx, 1);
  st.adminList = st.adminList.filter((n) => n !== name);
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
    groups.push({ id: i, members: [], performanceOrder: [], spokenMembers: [], status: 'pending' });
  }
  shuffled.forEach((p, idx) => {
    const gIdx = idx % n;
    groups[gIdx].members.push(p.name);
    p.groupIndex = gIdx;
  });

  st.groups = groups;
  st.spinState = null;
  st.speakerLog = [];
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
  p.wantsToCompete = true;
  p.joinedAfterRegistration = false;
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
  st.spinState = {
    groupId,
    names: shuffled,
    startedAt: Date.now(),
    durationMs: 2200,
    winner: shuffled[0] || null,
  };
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
      st.currentSpeaker = { name: speakerName, groupId, startTime: Date.now(), timerState: 'running', stoppedAt: null, disqualified: false };
    } else {
      st.currentSpeaker.startTime = Date.now();
      st.currentSpeaker.stoppedAt = null;
      st.currentSpeaker.disqualified = false;
      st.currentSpeaker.timerState = 'running';
    }
    st.spinState = null;
  } else if (action === 'stop') {
    if (st.currentSpeaker && st.currentSpeaker.timerState === 'running') {
      const stoppedAt = Date.now();
      const elapsedS = (stoppedAt - st.currentSpeaker.startTime) / 1000;
      const sil = st.settings.silenceEnd;
      const red = st.settings.redEnd;
      const dq = elapsedS < (sil - 5) || elapsedS > (red + 5);
      st.currentSpeaker.timerState = 'stopped';
      st.currentSpeaker.stoppedAt = stoppedAt;
      st.currentSpeaker.disqualified = dq;
      if (dq) {
        const name = st.currentSpeaker.name;
        if (name && !st.disqualifiedSpeakers.includes(name)) {
          st.disqualifiedSpeakers.push(name);
        }
      }

      const phase = st.phase;
      const speakerNameForLog = st.currentSpeaker.name;
      if (speakerNameForLog) {
        upsertSpeakerLogEntry(st, {
          name: speakerNameForLog,
          phase,
          groupId: st.currentSpeaker.groupId ?? null,
          durationMs: Math.max(0, stoppedAt - st.currentSpeaker.startTime),
          disqualified: dq,
          spokenAt: stoppedAt,
        });
      }

      if (phase === 'group' && speakerNameForLog) {
        const group = st.groups.find((g) => g.id === st.currentSpeaker.groupId);
        if (group) {
          if (!Array.isArray(group.spokenMembers)) group.spokenMembers = [];
          if (!group.spokenMembers.includes(speakerNameForLog)) {
            group.spokenMembers.push(speakerNameForLog);
          }
        }
      }
    }
  } else if (action === 'restart') {
    if (st.currentSpeaker) {
      st.currentSpeaker.startTime = Date.now();
      st.currentSpeaker.stoppedAt = null;
      st.currentSpeaker.disqualified = false;
      st.currentSpeaker.timerState = 'running';
    }
    st.spinState = null;
  } else if (action === 'set-speaker') {
    st.currentSpeaker = { name: speakerName, groupId, startTime: null, stoppedAt: null, disqualified: false, timerState: 'idle' };
    st.spinState = null;
    if (st.phase === 'group' && typeof groupId === 'number') {
      st.groups.forEach((g) => {
        if (g.status === 'active' && g.id !== groupId) g.status = 'pending';
      });
      const group = st.groups.find((g) => g.id === groupId);
      if (group && group.status !== 'done') group.status = 'active';
    }
  }

  bump();
  res.json({ ok: true, currentSpeaker: st.currentSpeaker });
});

// ── Admin: Override DQ ────────────────────────────────────────────────────────

app.post('/api/admin/override-dq', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { name } = req.body;
  const st = getState();
  const idx = st.disqualifiedSpeakers.indexOf(name);
  if (idx !== -1) st.disqualifiedSpeakers.splice(idx, 1);
  if (st.currentSpeaker && st.currentSpeaker.name === name) {
    st.currentSpeaker.disqualified = false;
  }
  bump();
  res.json({ ok: true });
});

// ── Demo seed ─────────────────────────────────────────────────────────────────

const DEMO_PARTICIPANTS = [
  { name: 'Alice Thornton', role: 'competitor' },
  { name: 'Bob Hargrove', role: 'competitor' },
  { name: 'Clara Voss', role: 'competitor' },
  { name: 'Dario Espinoza', role: 'competitor' },
  { name: 'Elena Marsh', role: 'competitor' },
  { name: "Finn O'Brien", role: 'competitor' },
  { name: 'Grace Liu', role: 'competitor' },
  { name: 'Hector Patel', role: 'competitor' },
  { name: 'Iris Nakamura', role: 'competitor' },
  { name: 'Jack Fontaine', role: 'competitor' },
  { name: 'Kira Svensson', role: 'competitor' },
  { name: 'Luca Ferretti', role: 'competitor' },
  { name: 'Morgan Hayes', role: 'observer' },
];

app.post('/api/admin/demo-seed', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const st = getState();
  if (st.phase !== 'registration') {
    return res.status(400).json({ error: 'Demo seed only available during registration' });
  }
  let added = 0;
  for (const { name, role } of DEMO_PARTICIPANTS) {
    if (!st.participants.some((p) => p.name === name)) {
      st.participants.push({
        name,
        role,
        wantsToCompete: role === 'competitor',
        joinedAfterRegistration: false,
        groupIndex: null,
        joinedAt: Date.now() + added,
        isAdmin: false,
      });
      added++;
    }
  }
  bump();
  res.json({ ok: true, added });
});

// ── Self opt-out ──────────────────────────────────────────────────────────────

app.post('/api/self-opt', (req, res) => {
  const { name, role } = req.body;
  const allowed = requireSelf(req, res, name);
  if (!allowed) return;
  const st = getState();
  if (st.phase !== 'registration') {
    return res.status(400).json({ error: 'Registration already closed' });
  }
  const p = st.participants.find((x) => x.name === name);
  if (!p) return res.status(404).json({ error: 'Participant not found' });
  p.role = role === 'competitor' ? 'competitor' : 'observer';
  p.wantsToCompete = p.role === 'competitor';
  p.joinedAfterRegistration = false;
  bump();
  res.json({ ok: true, role: p.role });
});

// ── Admin: Open voting ────────────────────────────────────────────────────────

app.post('/api/admin/open-voting', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const st = getState();
  const { candidates: rawCandidates, windowSeconds, excludeParticipants } = req.body;

  if (!rawCandidates || !Array.isArray(rawCandidates)) {
    return res.status(400).json({ error: 'Candidates required' });
  }

  if (st.phase === 'group') {
    const activeGroup = st.groups.find((g) => g.status === 'active');
    if (!activeGroup) {
      return res.status(400).json({ error: 'No active group selected' });
    }
    const spokenSet = new Set(activeGroup.spokenMembers || []);
    const allSpoken = activeGroup.members.every((name) => spokenSet.has(name));
    if (!allSpoken) {
      return res.status(400).json({ error: 'All active group speakers must complete speaking before voting opens' });
    }
  }

  // Filter DQ'd speakers from candidates
  const candidates = rawCandidates.filter((c) => !st.disqualifiedSpeakers.includes(c));

  // Eligible = all participants except candidates and any explicitly excluded speakers.
  // Active round members should see voting in progress but not receive a ballot.
  const excluded = new Set([...candidates, ...(excludeParticipants || [])]);
  const eligible = st.participants
    .filter((p) => !excluded.has(p.name))
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

function votingTop2(st) {
  if (!st.voting.results) return { winner: null, loser: null, winner_votes: 0, loser_votes: 0 };
  const entries = Object.entries(st.voting.results).sort((a, b) => b[1] - a[1]);
  return {
    winner: entries[0]?.[0] ?? null,
    winner_votes: entries[0]?.[1] ?? 0,
    loser: entries[1]?.[0] ?? null,
    loser_votes: entries[1]?.[1] ?? 0,
  };
}

app.post('/api/admin/advance', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { action, data } = req.body;
  const st = getState();

  if (action === 'next-speaker') {
    // Mark current speaker as spoken in their phase tracking
    if (st.currentSpeaker) {
      const name = st.currentSpeaker.name;
      if (st.phase === 'group' && name) {
        const group = st.groups.find((g) => g.id === st.currentSpeaker.groupId);
        if (group) {
          if (!Array.isArray(group.spokenMembers)) group.spokenMembers = [];
          if (!group.spokenMembers.includes(name)) group.spokenMembers.push(name);
        }
      } else if (st.phase === 'quarter_debate' && name) {
        if (!st.bracket.quarter_spoken.includes(name)) st.bracket.quarter_spoken.push(name);
      } else if (st.phase === 'semi_final' && name) {
        st.bracket.semi_pairs.forEach((pair, pairIdx) => {
          if (pair.includes(name)) {
            if (!st.bracket.semi_spoken[pairIdx]) st.bracket.semi_spoken[pairIdx] = [];
            if (!st.bracket.semi_spoken[pairIdx].includes(name)) st.bracket.semi_spoken[pairIdx].push(name);
          }
        });
      }
    }
    st.currentSpeaker = null;
    st.currentQuestion = null;
    st.spinState = null;
    bump();

  } else if (action === 'complete-group') {
    const { groupId } = data || {};
    const group = st.groups.find((g) => g.id === groupId);
    if (!group) { res.status(400).json({ error: 'Group not found' }); return; }

    // Auto-detect winner + runner_up from voting results
    const { winner: vWinner, loser: vRunnerUp, loser_votes: vRunnerVotes } = votingTop2(st);
    const winner = (data && data.winner) || vWinner;
    const runner_up = vRunnerUp;
    const runner_up_votes = vRunnerVotes;

    const idx = st.bracket.group_results.findIndex((r) => r.groupId === groupId);
    const result = { groupId, winner, runner_up, runner_up_votes };
    if (idx >= 0) st.bracket.group_results[idx] = result;
    else st.bracket.group_results.push(result);

    group.status = 'done';
    group.spokenMembers = [...new Set(group.members)];
    st.groups.forEach((g) => {
      if (g.id !== groupId && g.status === 'active') g.status = 'pending';
    });
    st.currentSpeaker = null;
    st.currentQuestion = null;
    st.spinState = null;
    bump();

  } else if (action === 'start-quarter') {
    const results = st.bracket.group_results;
    const winners = results.map((r) => r.winner).filter(Boolean);
    const runnersUp = results
      .filter((r) => r.runner_up)
      .map((r) => ({ name: r.runner_up, votes: r.runner_up_votes }))
      .sort((a, b) => b.votes - a.votes);

    const needed = Math.max(0, 8 - winners.length);
    const advancingRunners = runnersUp.slice(0, needed).map((r) => r.name);
    const advancing = [...new Set([...winners, ...advancingRunners])].slice(0, 8);

    const shuffled = [...advancing].sort(() => Math.random() - 0.5);
    st.bracket.advancing = advancing;
    st.bracket.quarter_groups = [shuffled.slice(0, 4), shuffled.slice(4)];
    st.bracket.quarter_spoken = [];
    st.bracket.quarter_winner_idx = null;
    st.spinState = null;
    st.phase = 'quarter_debate';
    bump();

  } else if (action === 'complete-quarter') {
    // Auto-detect winner group from voting ('Group A' vs 'Group B')
    let winnerIdx = data && data.winnerGroupIdx != null ? data.winnerGroupIdx : null;
    if (winnerIdx === null && st.voting.results) {
      const gA = st.voting.results['Group A'] || 0;
      const gB = st.voting.results['Group B'] || 0;
      winnerIdx = gA >= gB ? 0 : 1;
    }
    st.bracket.quarter_winner_idx = winnerIdx ?? 0;
    st.currentSpeaker = null;
    st.currentQuestion = null;
    st.spinState = null;
    bump();

  } else if (action === 'start-semi') {
    const wIdx = st.bracket.quarter_winner_idx;
    if (wIdx === null || wIdx === undefined) { res.status(400).json({ error: 'Quarter result not set' }); return; }
    const four = st.bracket.quarter_groups[wIdx] || [];
    const shuffled = [...four].sort(() => Math.random() - 0.5);
    st.bracket.semi_pairs = [[shuffled[0], shuffled[1]], [shuffled[2], shuffled[3]]];
    st.bracket.semi_spoken = [[], []];
    st.bracket.semi_results = [];
    st.bracket.finalists = [];
    st.bracket.third_place_candidates = [];
    st.spinState = null;
    st.phase = 'semi_final';
    bump();

  } else if (action === 'complete-semi') {
    const { pairIdx } = data || {};
    const { winner, winner_votes, loser, loser_votes } = votingTop2(st);
    const finalWinner = (data && data.winner) || winner;
    const finalLoser = (data && data.loser) || loser;
    const votesSnapshot = { ...(st.voting.votes || {}) };

    st.bracket.semi_results.push({ pairIdx, winner: finalWinner, loser: finalLoser, winner_votes, loser_votes, votesSnapshot });
    if (finalWinner && !st.bracket.finalists.includes(finalWinner)) st.bracket.finalists.push(finalWinner);
    if (finalLoser) st.bracket.third_place_candidates.push({ name: finalLoser, votes: loser_votes, pairIdx });

    st.currentSpeaker = null;
    st.currentQuestion = null;
    st.spinState = null;
    bump();

  } else if (action === 'start-final') {
    st.spinState = null;
    st.phase = 'final';
    bump();

  } else if (action === 'complete-final') {
    const { winner, loser } = votingTop2(st);
    const finalWinner = (data && data.winner) || winner;
    const finalLoser = (data && data.loser) || loser;
    st.bracket.champion = finalWinner;
    st.bracket.final_result = { winner: finalWinner, loser: finalLoser };
    st.currentSpeaker = null;
    st.currentQuestion = null;
    st.spinState = null;
    bump();

  } else if (action === 'reveal-podium') {
    const cands = st.bracket.third_place_candidates;
    let third = null;

    if (cands.length === 1) {
      third = cands[0].name;
    } else if (cands.length >= 2) {
      let v0 = cands[0].votes;
      let v1 = cands[1].votes;

      if (v0 === v1) {
        // Apply tiebreak: remove first admin's vote from the matchup they voted in
        const firstAdmin = st.participants
          .filter((p) => st.adminList.includes(p.name))
          .sort((a, b) => a.joinedAt - b.joinedAt)[0];

        if (firstAdmin) {
          const r0 = st.bracket.semi_results.find((r) => r.pairIdx === cands[0].pairIdx);
          const r1 = st.bracket.semi_results.find((r) => r.pairIdx === cands[1].pairIdx);
          if (r0 && r0.votesSnapshot && r0.votesSnapshot[firstAdmin.name] === cands[0].name) v0--;
          if (r1 && r1.votesSnapshot && r1.votesSnapshot[firstAdmin.name] === cands[1].name) v1--;
        }
      }

      if (v0 > v1) third = cands[0].name;
      else if (v1 > v0) third = cands[1].name;
      else third = (data && data.thirdPlace) || null; // admin decisive vote
    }

    st.bracket.third_place = third;
    // Only close if 3rd place is resolved
    if (third || (data && data.thirdPlace !== undefined)) st.phase = 'closed';
    st.spinState = null;
    bump();

  } else if (action === 'close') {
    st.spinState = null;
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
  if (process.argv.includes('--demo')) {
    const st = getState();
    for (const { name, role } of DEMO_PARTICIPANTS) {
      if (!st.participants.some((p) => p.name === name)) {
        st.participants.push({
          name,
          role,
          wantsToCompete: role === 'competitor',
          joinedAfterRegistration: false,
          groupIndex: null,
          joinedAt: Date.now(),
          isAdmin: false,
        });
      }
    }
    bump();
    console.log('[tm-olympics] Demo mode: seeded', DEMO_PARTICIPANTS.length, 'participants');
  }
});

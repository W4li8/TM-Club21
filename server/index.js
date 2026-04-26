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

// ── Public: known-name check & phases ────────────────────────────────────────

app.get('/api/known-name', (req, res) => {
  const name = (req.query.name || '').trim();
  const st = getState();
  const known = st.participants.some((p) => p.name === name);
  res.json({ known });
});

app.get('/api/phases', (req, res) => {
  res.json(getPhases());
});

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
      st.currentSpeaker = { name: speakerName, groupId, startTime: Date.now(), timerState: 'running', stoppedAt: null, disqualified: false };
    } else {
      st.currentSpeaker.startTime = Date.now();
      st.currentSpeaker.stoppedAt = null;
      st.currentSpeaker.disqualified = false;
      st.currentSpeaker.timerState = 'running';
    }
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
    }
  } else if (action === 'restart') {
    if (st.currentSpeaker) {
      st.currentSpeaker.startTime = Date.now();
      st.currentSpeaker.stoppedAt = null;
      st.currentSpeaker.disqualified = false;
      st.currentSpeaker.timerState = 'running';
    }
  } else if (action === 'set-speaker') {
    st.currentSpeaker = { name: speakerName, groupId, startTime: null, stoppedAt: null, disqualified: false, timerState: 'idle' };
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

// ── Self opt-out ──────────────────────────────────────────────────────────────

app.post('/api/self-opt', (req, res) => {
  if (!checkUser(req, res)) return;
  const { name, role } = req.body;
  const st = getState();
  if (st.phase !== 'registration') {
    return res.status(400).json({ error: 'Registration already closed' });
  }
  const p = st.participants.find((x) => x.name === name);
  if (!p) return res.status(404).json({ error: 'Participant not found' });
  p.role = role === 'competitor' ? 'competitor' : 'observer';
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

  // Filter DQ'd speakers from candidates
  const candidates = rawCandidates.filter((c) => !st.disqualifiedSpeakers.includes(c));

  // Eligible = all participants except candidates AND any explicitly excluded speakers
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
      if (st.phase === 'quarter_debate' && name) {
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
    st.currentSpeaker = null;
    st.currentQuestion = null;
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
    bump();

  } else if (action === 'start-final') {
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

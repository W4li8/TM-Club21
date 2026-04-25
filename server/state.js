'use strict';

const defaultSettings = {
  silenceEnd: 45,
  greenEnd: 60,
  yellowEnd: 75,
  redEnd: 90,
  votingWindowSeconds: 60,
  numGroups: 5,
  maxPerGroup: null,
  breakMinutes: 5,
  stageLabels: {
    group_stage: 'Group Stage',
    quarter_debate: 'Quarter-Debate',
    semi_final: 'Semifinal',
    final: 'Final',
  },
};

let state = {
  phase: 'registration',
  settings: JSON.parse(JSON.stringify(defaultSettings)),
  participants: [],
  groups: [],
  currentSpeaker: null,
  currentQuestion: null,
  usedQuestions: { group_stage: [], quarter_debate: [], semi_final: [], final: [] },
  voting: {
    active: false,
    windowSeconds: 60,
    openedAt: null,
    votes: {},
    eligibleVoters: [],
    results: null,
    tiebreakAdminVoteUsed: false,
  },
  bracket: {
    group_winners: [],
    quarter_teams: [],
    semi_winners: [],
    finalist: null,
  },
  adminList: [],
  version: 0,
};

function bump() {
  state.version += 1;
}

function getState() {
  return state;
}

function resetState() {
  state = {
    phase: 'registration',
    settings: JSON.parse(JSON.stringify(defaultSettings)),
    participants: [],
    groups: [],
    currentSpeaker: null,
    currentQuestion: null,
    usedQuestions: { group_stage: [], quarter_debate: [], semi_final: [], final: [] },
    voting: {
      active: false,
      windowSeconds: 60,
      openedAt: null,
      votes: {},
      eligibleVoters: [],
      results: null,
      tiebreakAdminVoteUsed: false,
    },
    bracket: {
      group_winners: [],
      quarter_teams: [],
      semi_winners: [],
      finalist: null,
    },
    adminList: [],
    version: 0,
  };
}

module.exports = { getState, bump, resetState };

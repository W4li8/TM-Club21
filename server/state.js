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

function freshBracket() {
  return {
    // Group stage results: [{groupId, winner, runner_up, runner_up_votes}]
    group_results: [],
    // 8 names advancing to quarter-debate
    advancing: [],
    // Two groups of 4: [groupA[], groupB[]]
    quarter_groups: [[], []],
    // Names who have already spoken in quarter-debate
    quarter_spoken: [],
    // 0 = Group A won, 1 = Group B won
    quarter_winner_idx: null,
    // Two 1v1 pairs for semi: [[n1,n2],[n3,n4]]
    semi_pairs: [],
    // Names spoken per pair: [[],[]]
    semi_spoken: [[], []],
    // [{pairIdx, winner, loser, winner_votes, loser_votes}]
    semi_results: [],
    // The two finalists
    finalists: [],
    // {winner, loser} — result of the final
    final_result: null,
    // Champion name
    champion: null,
    // [{name, votes}] — the two semi losers competing for 3rd
    third_place_candidates: [],
    // 3rd place name
    third_place: null,
  };
}

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
  bracket: freshBracket(),
  adminList: [],
  disqualifiedSpeakers: [],
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
    bracket: freshBracket(),
    adminList: [],
    disqualifiedSpeakers: [],
    version: 0,
  };
}

module.exports = { getState, bump, resetState };

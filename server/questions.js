'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

let questions = null;

function loadQuestions() {
  const filePath = path.join(__dirname, '..', 'questions.yaml');
  const raw = fs.readFileSync(filePath, 'utf8');
  questions = yaml.load(raw);
  console.log('[questions] Loaded questions from questions.yaml');
}

// Returns the theme object { theme, questions } for a group theme index (0-based)
function getGroupTheme(themeIndex) {
  if (!questions || !questions.group_themes) return null;
  return questions.group_themes[themeIndex] || null;
}

// Draws a random unused question from a specific group theme pool
function getRandomUnusedGroupQuestion(themeIndex, usedList) {
  if (!questions) throw new Error('Questions not loaded');
  const themeObj = questions.group_themes && questions.group_themes[themeIndex];
  if (!themeObj) throw new Error(`Unknown group theme index: ${themeIndex}`);
  const available = themeObj.questions.filter((q) => !usedList.includes(q));
  if (available.length === 0) return null;
  const idx = Math.floor(Math.random() * available.length);
  return { text: available[idx], theme: themeObj.theme };
}

// Draws a random unused question from non-group stages (quarter_debate, semi_final, final)
function getRandomUnusedQuestion(stageName, usedList) {
  if (!questions) throw new Error('Questions not loaded');
  const stage = questions[stageName];
  if (!stage) throw new Error(`Unknown stage: ${stageName}`);
  const available = stage.questions.filter((q) => !usedList.includes(q));
  if (available.length === 0) return null;
  const idx = Math.floor(Math.random() * available.length);
  return { text: available[idx], theme: stage.theme };
}

function getTheme(stageName) {
  if (!questions || !questions[stageName]) return '';
  return questions[stageName].theme;
}

function getPhases() {
  return (questions && questions.phases) || {};
}

module.exports = { loadQuestions, getGroupTheme, getRandomUnusedGroupQuestion, getRandomUnusedQuestion, getTheme, getPhases };

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

module.exports = { loadQuestions, getRandomUnusedQuestion, getTheme };

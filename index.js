import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import twilio from 'twilio';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load playbooks
const week1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'content/week1_playbook_progress.json')));
const week2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'content/week2_playbook_progress.json')));
const playbooks = [week1, week2];

// In-memory user state
const users = new Map();

function sendWhatsApp(to, lines) {
  const body = lines.filter(Boolean).join('\n');
  return client.messages.create({ from: FROM, to, body });
}

function bilingual(es, en, mode) {
  if (mode === 'ES') return [`ES: ${es}`];
  if (mode === 'EN') return [`EN: ${en}`];
  return [`ES: ${es}`, `EN: ${en.slice(0,120)}`];
}

function getUserState(from) {
  if (!users.has(from)) {
    users.set(from, { mode: 'BILINGÜE', lessonId: 'L01', accuracy: 1.0, lastQuiz: null, expectTask: null });
  }
  return users.get(from);
}

function findLesson(lessonId) {
  for (const pb of playbooks) {
    const lesson = pb.lesson_plans.find(l => l.id === lessonId);
    if (lesson) return { lesson, pb };
  }
  return null;
}

function nextLessonId(currentId) {
  const ids = [];
  for (const pb of playbooks) ids.push(...pb.lesson_plans.map(l => l.id));
  const idx = ids.indexOf(currentId);
  return idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : currentId;
}

console.log("Webhook hit. From:", req.body.From, "Text:", req.body.Body);
app.post('/webhook/whatsapp', async (req, res) => {
  const from = req.body.From;
  const text = (req.body.Body || '').trim();
  const state = getUserState(from);

  if (['ES','EN','BILINGÜE','BILINGUE'].includes(text.toUpperCase())) {
    state.mode = text.toUpperCase().replace('BILINGUE','BILINGÜE');
    await sendWhatsApp(from, bilingual(`Modo actualizado: ${state.mode}.`, `Mode updated: ${state.mode}.`, state.mode));
    return res.end();
  }

  const found = findLesson(state.lessonId) || {};
  const { lesson, pb } = found;

  if (/^WARMUP$/i.test(text)) {
    const opener = pb.openers.find(o => o.id === lesson.warmup);
    if (opener) await sendWhatsApp(from, bilingual(opener.es, opener.en, state.mode));
    return res.end();
  }

  if (/^QUIZ$/i.test(text)) {
    const qid = lesson.quiz[0];
    const q = pb.quizzes.find(x => x.id === qid);
    if (q) {
      await sendWhatsApp(from, ['ES: ' + q.prompt]);
      state.lastQuiz = qid;
    }
    return res.end();
  }

  if (state.lastQuiz) {
    const q = pb.quizzes.find(x => x.id === state.lastQuiz);
    if (q) {
      const norm = s => String(s).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'').trim();
      const correct = norm(text) === norm(q.answer);
      if (correct) {
        await sendWhatsApp(from, bilingual('¡Correcto! 👏', 'Correct!', state.mode));
        state.accuracy = (state.accuracy * 0.7) + (1 * 0.3);
      } else {
        await sendWhatsApp(from, bilingual(`Casi. Modelo: ${q.answer}`, `Almost. Model: ${q.answer}`, state.mode));
        state.accuracy = (state.accuracy * 0.7);
      }
      state.lastQuiz = null;
    }
    return res.end();
  }

  if (/^TASK$/i.test(text)) {
    const task = pb.tasks.find(t => t.id === lesson.task);
    if (task) {
      await sendWhatsApp(from, bilingual(task.es, task.en, state.mode));
      state.expectTask = lesson.task;
    }
    return res.end();
  }

  if (state.expectTask) {
    await sendWhatsApp(from, bilingual('¡Gracias! Tarea recibida.', 'Thanks! Task received.', state.mode));
    state.expectTask = null;
    state.lessonId = nextLessonId(state.lessonId);
    await sendWhatsApp(from, bilingual(`Avanzamos a la lección ${state.lessonId}.`, `Advancing to lesson ${state.lessonId}.`, state.mode));
    return res.end();
  }

  if (/^REFLECT$/i.test(text)) {
    const refl = pb.reflections.find(r => r.id === lesson.reflection);
    if (refl) await sendWhatsApp(from, bilingual(refl.es, refl.en, state.mode));
    return res.end();
  }

  await sendWhatsApp(from, bilingual(
    'Comandos: WARMUP, QUIZ, TASK, REFLECT, ES, EN, BILINGÜE.',
    'Commands: WARMUP, QUIZ, TASK, REFLECT, ES, EN, BILINGÜE.',
    state.mode
  ));
  res.end();
});

app.get('/', (_,res)=> res.send('OK'));
// Add this near the bottom of index.js, above app.listen()

// Simple starter bank by slot
const starters = {
  morning: {
    es: "¿Qué desayunaste hoy? 🌞",
    en: "What did you have for breakfast today? 🌞"
  },
  noon: {
    es: "Háblame de tu familia 👨‍👩‍👧",
    en: "Tell me about your family 👨‍👩‍👧"
  },
  evening: {
    es: "¿Te gusta ver películas? 🎬",
    en: "Do you like watching movies? 🎬"
  }
};

// Endpoint for scheduled triggers
app.get('/cron/trigger', async (req, res) => {
  const slot = req.query.slot; // morning | noon | evening
  const starter = starters[slot];

  if (!starter) {
    return res.end("Invalid slot");
  }

  // Send to all active users
  for (const [phone, state] of users.entries()) {
    await sendWhatsApp(phone, bilingual(starter.es, starter.en, state.mode));
  }

  res.end("Starter sent");
});

app.listen(process.env.PORT || 3000, ()=> console.log('Server running'));

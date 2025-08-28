import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import twilio from 'twilio';
import pkg from 'pg';

const { Pool } = pkg;
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

// Postgres connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// __dirname fix for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load playbooks
const week1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'content/week1_playbook_progress.json')));
const week2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'content/week2_playbook_progress.json')));
const playbooks = [week1, week2];

// Send WhatsApp
function sendWhatsApp(to, lines) {
  const body = lines.filter(Boolean).join('\n');
  return client.messages.create({ from: FROM, to, body });
}

// Bilingual helper
function bilingual(es, en, mode) {
  if (mode === 'ES') return [`ES: ${es}`];
  if (mode === 'EN') return [`EN: ${en}`];
  return [`ES: ${es}`, `EN: ${en}`];
}

// DB-backed user state
async function getOrCreateUser(phone) {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (result.rows.length > 0) {
      return result.rows[0];
    } else {
      const insert = await client.query(
        `INSERT INTO users (phone, mode, lesson_id, accuracy) 
         VALUES ($1, $2, $3, $4) 
         RETURNING *`,
        [phone, 'BILINGÜE', 'L01', 1.0]
      );
      return insert.rows[0];
    }
  } finally {
    client.release();
  }
}

// Find lesson
function findLesson(lessonId) {
  for (const pb of playbooks) {
    const lesson = pb.lesson_plans.find(l => l.id === lessonId);
    if (lesson) return { lesson, pb };
  }
  return null;
}

// Next lesson
function nextLessonId(currentId) {
  const ids = [];
  for (const pb of playbooks) ids.push(...pb.lesson_plans.map(l => l.id));
  const idx = ids.indexOf(currentId);
  return idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : currentId;
}

// ✅ Webhook
app.post('/webhook/whatsapp', async (req, res) => {
  console.log("Webhook hit. From:", req.body.From, "Text:", req.body.Body);

  const from = req.body.From;
  const text = (req.body.Body || '').trim();
  const state = await getOrCreateUser(from);

  if (['ES','EN','BILINGÜE','BILINGUE'].includes(text.toUpperCase())) {
    state.mode = text.toUpperCase().replace('BILINGUE','BILINGÜE');
    await sendWhatsApp(from, bilingual(`Modo actualizado: ${state.mode}.`, `Mode updated: ${state.mode}.`, state.mode));
    return res.end();
  }

  const found = findLesson(state.lesson_id) || {};
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

  if (/^TASK$/i.test(text)) {
    const task = pb.tasks.find(t => t.id === lesson.task);
    if (task) {
      await sendWhatsApp(from, bilingual(task.es, task.en, state.mode));
      state.expectTask = lesson.task;
    }
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

// Root route
app.get('/', (_,res)=> res.send('OK'));

// Starters for cron
const starters = {
  morning: { es: "¿Qué desayunaste hoy? 🌞", en: "What did you have for breakfast today? 🌞" },
  noon: { es: "Háblame de tu familia 👨‍👩‍👧", en: "Tell me about your family 👨‍👩‍👧" },
  evening: { es: "¿Te gusta ver películas? 🎬", en: "Do you like watching movies? 🎬" }
};

app.get('/cron/trigger', async (req, res) => {
  const slot = req.query.slot; // morning | noon | evening
  const starter = starters[slot];
  if (!starter) return res.end("Invalid slot");

  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM users');
    for (const row of result.rows) {
      await sendWhatsApp(row.phone, bilingual(starter.es, starter.en, row.mode));
    }
  } finally {
    client.release();
  }

  res.end("Starter sent");
});

app.listen(process.env.PORT || 3000, ()=> console.log('Server running'));

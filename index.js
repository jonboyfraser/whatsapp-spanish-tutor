import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import twilio from 'twilio';
import pkg from 'pg';
import OpenAI from "openai";

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

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// __dirname fix for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load playbooks
const week1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'content/week1_playbook_progress.json')));
const week2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'content/week2_playbook_progress.json')));
const playbooks = [week1, week2];

// Load new quiz/task libraries
const quizzes = JSON.parse(fs.readFileSync(path.join(__dirname, 'content/quizzes.json')));
const tasks = JSON.parse(fs.readFileSync(path.join(__dirname, 'content/tasks.json')));

// Helper to pick random item
function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Send WhatsApp
function sendWhatsApp(to, lines) {
  const body = lines.filter(Boolean).join('\n');
  return client.messages.create({ from: FROM, to, body });
}

// Bilingual helper
function bilingual(es, en, mode) {
  if (mode === 'ES') return [es];
  if (mode === 'EN') return [en];
  return [es, en];
}

// DB helpers
async function getOrCreateUser(phone) {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (result.rows.length > 0) {
      return result.rows[0];
    } else {
      const insert = await client.query(
        `INSERT INTO users (phone, mode, lesson_id, accuracy, lastquiz, expecttask) 
         VALUES ($1, $2, $3, $4, $5, $6) 
         RETURNING *`,
        [phone, 'BILINGÜE', 'L01', 1.0, null, null]
      );
      return insert.rows[0];
    }
  } finally {
    client.release();
  }
}

async function updateUser(phone, fields) {
  const client = await pool.connect();
  try {
    const set = Object.keys(fields)
      .map((key, i) => `${key} = $${i + 2}`)
      .join(', ');
    const values = [phone, ...Object.values(fields)];
    await client.query(`UPDATE users SET ${set}, updated_at = NOW() WHERE phone = $1`, values);
  } finally {
    client.release();
  }
}

// Analyse answer with GPT
async function analyseAnswer(userAnswer, prompt, expectedLanguage) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a friendly Spanish tutor.
Correct learners like a pen pal would.
Always reply in Spanish AND English.
Be concise: first give the corrected model answer in Spanish, then a short English explanation.`
      },
      {
        role: "user",
        content: `Prompt: ${prompt}
Expected language: ${expectedLanguage}
Learner answer: ${userAnswer}`
      }
    ],
    max_tokens: 150
  });

  return completion.choices[0].message.content;
}

// Lesson helpers
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

// ✅ Webhook
app.post('/webhook/whatsapp', async (req, res) => {
  console.log("Webhook hit. From:", req.body.From, "Text:", req.body.Body);

  const from = req.body.From;
  const text = (req.body.Body || '').trim();
  const state = await getOrCreateUser(from);

  // Manual override of mode
  if (['ES','EN','BILINGÜE','BILINGUE'].includes(text.toUpperCase())) {
    const newMode = text.toUpperCase().replace('BILINGUE','BILINGÜE');
    await updateUser(from, { mode: newMode });
    await sendWhatsApp(from, bilingual(`Modo actualizado: ${newMode}.`, `Mode updated: ${newMode}.`, newMode));
    return res.end();
  }

  const found = findLesson(state.lesson_id) || {};
  const { lesson, pb } = found;

  if (!lesson) {
    await sendWhatsApp(from, bilingual('No se encontró la lección.', 'Lesson not found.', 'BILINGÜE'));
    return res.end();
  }

  // QUIZ → Pick random quiz
  if (/^QUIZ$/i.test(text)) {
    const quiz = randomItem(quizzes);
    await sendWhatsApp(from, [quiz.prompt]);
    await updateUser(from, { lastquiz: quiz.id });
    return res.end();
  }

  // If user is answering a quiz
  if (state.lastquiz) {
    const quiz = quizzes.find(q => q.id === state.lastquiz);
    if (quiz) {
      const feedback = await analyseAnswer(text, quiz.prompt, quiz.expected_language);

      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO messages (user_id, prompt_id, user_answer, analysis, score)
           VALUES ($1, $2, $3, $4, $5)`,
          [state.id, quiz.id, text, feedback, null]
        );
      } finally {
        client.release();
      }

      await updateUser(from, { lastquiz: null });
      await sendWhatsApp(from, [feedback]);
    }
    return res.end();
  }

  // TASK → Pick random task
  if (/^TASK$/i.test(text)) {
    const task = randomItem(tasks);
    await sendWhatsApp(from, bilingual(task.prompt_es, task.prompt_en, 'BILINGÜE'));
    await updateUser(from, { expecttask: task.id });
    return res.end();
  }

  // If user is answering a task
  if (state.expecttask) {
    const task = tasks.find(t => t.id === state.expecttask);
    if (task) {
      const feedback = await analyseAnswer(text, task.prompt_es, task.expected_output);

      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO messages (user_id, prompt_id, user_answer, analysis, score)
           VALUES ($1, $2, $3, $4, $5)`,
          [state.id, task.id, text, feedback, null]
        );
      } finally {
        client.release();
      }

      await updateUser(from, { expecttask: null, lesson_id: nextLessonId(state.lesson_id) });
      await sendWhatsApp(from, [feedback]);
    }
    return res.end();
  }

  // REFLECT → BILINGÜE
  if (/^REFLECT$/i.test(text)) {
    const refl = pb.reflections.find(r => r.id === lesson.reflection);
    if (refl) await sendWhatsApp(from, bilingual(refl.es, refl.en, 'BILINGÜE'));
    return res.end();
  }

  // Default help → bilingual
  await sendWhatsApp(from, bilingual(
    'Comandos: WARMUP, QUIZ, TASK, REFLECT, ES, EN, BILINGÜE.',
    'Commands: WARMUP, QUIZ, TASK, REFLECT, ES, EN, BILINGÜE.',
    'BILINGÜE'
  ));
  res.end();
});

// Root
app.get('/', (_,res)=> res.send('OK'));

// Starters for cron → Spanish only
const starters = {
  morning: { es: "¿Qué desayunaste hoy? 🌞", en: "What did you have for breakfast today? 🌞" },
  noon: { es: "Háblame de tu familia 👨‍👩‍👧", en: "Tell me about your family 👨‍👩‍👧" },
  evening: { es: "¿Te gusta ver películas? 🎬", en: "Do you like watching movies? 🎬" }
};

app.get('/cron/trigger', async (req, res) => {
  const slot = req.query.slot;
  const starter = starters[slot];
  if (!starter) return res.end("Invalid slot");

  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM users');
    for (const row of result.rows) {
      await sendWhatsApp(row.phone, bilingual(starter.es, starter.en, 'ES'));
    }
  } finally {
    client.release();
  }

  res.end("Starter sent");
});

app.listen(process.env.PORT || 3000, ()=> console.log('Server running'));

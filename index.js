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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Analyse answer with GPT and save to DB
async function analyseAndSave(userId, promptId, userAnswer) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a strict but friendly Spanish tutor.
Always start with one of these tags:
- "✔️ Correcto" if the answer is correct
- "🤏 Casi" if the answer is almost correct
- "❌ Incorrecto" if the answer is wrong
Then give a short correction in Spanish + English explanation. Always bilingual.`
        },
        {
          role: "user",
          content: userAnswer
        }
      ],
      max_tokens: 150
    });

    const analysis = completion.choices[0].message.content.trim();

    // Assign score based on prefix
    let score = 0;
    if (analysis.startsWith("✔️ Correcto")) score = 1;
    else if (analysis.startsWith("🤏 Casi")) score = 0.5;
    else if (analysis.startsWith("❌ Incorrecto")) score = 0;

    // Save to DB
    await pool.query(
      `INSERT INTO messages (user_id, prompt_id, user_answer, analysis, score, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [userId, promptId, userAnswer, analysis, score]
    );

    return { analysis, score };
  } catch (err) {
    console.error("Error in analyseAndSave:", err);
    return { analysis: "⚠️ Sorry, something went wrong analysing your answer.", score: 0 };
  }
}

// Webhook
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

  // QUIZ
  if (/^QUIZ$/i.test(text)) {
    const quiz = randomItem(quizzes);
    await sendWhatsApp(from, [quiz.prompt]);
    await updateUser(from, { lastquiz: quiz.id });
    return res.end();
  }

  // Answering a quiz
  if (state.lastquiz) {
    const quiz = quizzes.find(q => q.id === state.lastquiz);
    if (quiz) {
      const { analysis } = await analyseAndSave(state.id, quiz.id, text);
      await sendWhatsApp(from, [analysis]);
      await updateUser(from, { lastquiz: null });
    }
    return res.end();
  }

  // TASK
  if (/^TASK$/i.test(text)) {
    const task = randomItem(tasks);
    await sendWhatsApp(from, bilingual(task.prompt_es, task.prompt_en, 'BILINGÜE'));
    await updateUser(from, { expecttask: task.id });
    return res.end();
  }

  // Answering a task
  if (state.expecttask) {
    const task = tasks.find(t => t.id === state.expecttask);
    if (task) {
      const { analysis } = await analyseAndSave(state.id, task.id, text);
      await sendWhatsApp(from, [analysis]);
      await updateUser(from, { expecttask: null, lesson_id: 'L02' });
    }
    return res.end();
  }

  // Default help
  await sendWhatsApp(from, bilingual(
    'Comandos: QUIZ, TASK, ES, EN, BILINGÜE.',
    'Commands: QUIZ, TASK, ES, EN, BILINGÜE.',
    state.mode
  ));
  res.end();
});

// Root
app.get('/', (_,res)=> res.send('OK'));

// Starters for cron
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

require('dotenv').config();
const express = require('express');
const path = require('path');
const { runMigrations, pool } = require('./db');
const { basicAuth } = require('./middleware/basicAuth');
const fitnessRouter = require('./routes/fitness');
const { createWorkoutsRouter } = require('./routes/workouts');
const { createPercentilesRouter } = require('./routes/percentiles');
const { createNutritionRouter, createStore: createNutritionStore } = require('./routes/nutrition');
const { createCoachChatRouter } = require('./routes/coachChat');
const { createWardrobeRouter, createWardrobeStore } = require('./routes/wardrobe');
const { createExpeditionsRouter } = require('./routes/expeditions');
const { createRoleRouter } = require('./routes/role');
const { createSentinelPusher } = require('./lib/sentinel');
const { createSentinelReadRouter } = require('./routes/sentinelRead');
const { createSentinelActionsRouter, trackMountPaths } = require('./routes/sentinelActions');

// Record where each router is mounted so the Sentinel bridge can list routes.
trackMountPaths();

const app = express();
const PORT = process.env.PORT || 3000;
const sentinelPusher = createSentinelPusher({ pool });

// Expedition photos come as base64 JPEGs (shrunk in the browser, about 0.5 MB each): 12 MB for that route only.
app.use('/api/fitness/expeditions', express.json({ limit: '12mb' }));
// 1 MB, not the 100 KB default: the food search posts USDA's results from the browser (Oct 31: they were refused 413).
app.use(express.json({ limit: '1mb' }));

// Health check stays unauthenticated so Railway's health probe can hit it.
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.use(basicAuth);

// After any successful write under /api, push a fresh summary to Sentinel
// (~60 s debounced). Never blocks the request.
app.use('/api', sentinelPusher.middleware);

app.use('/api/fitness', fitnessRouter);
// Workout generator, one-tap logging, engine tests, Sentinel refine queue.
const workoutsRouter = createWorkoutsRouter({ pool });
app.use('/api/fitness', workoutsRouter);
// CrossFit / Concept2 percentiles and Open results.
app.use('/api/fitness', createPercentilesRouter({ pool }));
// Nutrition: food log, recipes, adaptive targets, meal plan, pantry, groceries (to Sentinel), the nutritionist.
app.use('/api/fitness', createNutritionRouter({ pool }));
// The wardrobe: his clothes, what to wear today, outfits, the wishlist (the stylist in the coach chat works on it).
app.use('/api/fitness', createWardrobeRouter({ pool }));
// The Andrew page (Nov 3): the role, the Trinity Bond courses through Sentinel, the actor's notebook.
app.use('/api/fitness', createRoleRouter({ pool }));
// Expeditions: trips on the map, journal pages with the day's weather, photos, and the training he did on the way.
app.use('/api/fitness', createExpeditionsRouter({ pool }));
// The coaches to talk to (trainer, nutritionist): Sentinel thinks, Self Hub keeps the conversation and the memory.
app.use('/api/fitness', createCoachChatRouter({ pool, workouts: workoutsRouter, nutrition: createNutritionStore(pool), wardrobe: createWardrobeStore(pool) }));
// Read-only lookup API for Sentinel's voice agent (same Basic auth).
app.use('/api/sentinel', createSentinelReadRouter({ pool }));
// Sentinel API bridge: list every /api route and call any of them as the owner.
app.use('/api/sentinel', createSentinelActionsRouter());

// The strength-score module is shared with the server so the Health tab and
// the Sentinel push can never disagree.
app.get('/js/strength.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'lib', 'strength.js'));
});
// The figure's muscle counting (lib/figure.js), shared with the page the same way.
app.get('/js/figure.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'lib', 'figure.js'));
});
// The trainer's coaching library (form, tempo, tension, what each movement does), shared the same way.
app.get('/js/coaching.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'lib', 'coaching.js'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));
// Express 5 requires a named wildcard, not a bare '*'.
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function start() {
  try {
    await runMigrations();
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`Self Hub listening on port ${PORT}`);
    sentinelPusher.start();
  });
}

start();

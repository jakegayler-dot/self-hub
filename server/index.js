require('dotenv').config();
const express = require('express');
const path = require('path');
const { runMigrations, pool } = require('./db');
const { basicAuth } = require('./middleware/basicAuth');
const fitnessRouter = require('./routes/fitness');
const { createWorkoutsRouter } = require('./routes/workouts');
const { createSentinelPusher } = require('./lib/sentinel');
const { createSentinelReadRouter } = require('./routes/sentinelRead');
const { createSentinelActionsRouter, trackMountPaths } = require('./routes/sentinelActions');

// Record where each router is mounted so the Sentinel bridge can list routes.
trackMountPaths();

const app = express();
const PORT = process.env.PORT || 3000;
const sentinelPusher = createSentinelPusher({ pool });

app.use(express.json());

// Health check stays unauthenticated so Railway's health probe can hit it.
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.use(basicAuth);

// After any successful write under /api, push a fresh summary to Sentinel
// (~60 s debounced). Never blocks the request.
app.use('/api', sentinelPusher.middleware);

app.use('/api/fitness', fitnessRouter);
// Workout generator, one-tap logging, engine tests, Sentinel refine queue.
app.use('/api/fitness', createWorkoutsRouter({ pool }));
// Read-only lookup API for Sentinel's voice agent (same Basic auth).
app.use('/api/sentinel', createSentinelReadRouter({ pool }));
// Sentinel API bridge: list every /api route and call any of them as the owner.
app.use('/api/sentinel', createSentinelActionsRouter());

// The strength-score module is shared with the server so the Health tab and
// the Sentinel push can never disagree.
app.get('/js/strength.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'lib', 'strength.js'));
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

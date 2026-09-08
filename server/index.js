require('dotenv').config();
const express = require('express');
const path = require('path');
const { runMigrations } = require('./db');
const { basicAuth } = require('./middleware/basicAuth');
const fitnessRouter = require('./routes/fitness');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check stays unauthenticated so Railway's health probe can hit it.
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.use(basicAuth);

app.use('/api/fitness', fitnessRouter);

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
  app.listen(PORT, () => console.log(`Self Hub listening on port ${PORT}`));
}

start();

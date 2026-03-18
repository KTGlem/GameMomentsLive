'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE broadcast registry ───────────────────────────────────────────────────

/** @type {Map<string, Set<import('http').ServerResponse>>} */
const sseClients = new Map();

function broadcast(gameId, payload) {
  const clients = sseClients.get(gameId);
  if (!clients || clients.size === 0) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function gameState(gameId) {
  const game = db.getGame(gameId);
  const events = db.getEvents(gameId);
  return { game, events };
}

const VALID_CODES = new Set([
  'goal_pfc', 'goal_opp',
  'kickoff_pfc', 'kickoff_opp',
  'sideout_pfc', 'sideout_opp',
  'goal_kick_pfc', 'goal_kick_opp',
  'corner_pfc', 'corner_opp',
  'free_kick_pfc', 'free_kick_opp',
]);

// ── Admin: create game ────────────────────────────────────────────────────────

app.post('/api/games', (req, res) => {
  const { date, team_name = 'PFC', opponent, venue = '' } = req.body;
  if (!opponent || !opponent.trim()) {
    return res.status(400).json({ error: 'opponent is required' });
  }

  const game_id = `game_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const logger_token = randomToken();
  const viewer_token = randomToken();

  db.createGame({
    game_id,
    date: date || new Date().toISOString().slice(0, 10),
    team_name: team_name.trim() || 'PFC',
    opponent: opponent.trim(),
    venue: venue.trim(),
    logger_token,
    viewer_token,
  });

  const origin = `${req.protocol}://${req.get('host')}`;
  res.json({
    game_id,
    logger_url: `${origin}/logger.html?gameId=${game_id}&token=${logger_token}`,
    scoreboard_url: `${origin}/scoreboard.html?gameId=${game_id}&token=${viewer_token}`,
  });
});

// ── Admin: list games ─────────────────────────────────────────────────────────

app.get('/api/games', (req, res) => {
  const games = db.listGames();
  const origin = `${req.protocol}://${req.get('host')}`;
  const result = games.map(g => ({
    game_id: g.game_id,
    date: g.date,
    team_name: g.team_name,
    opponent: g.opponent,
    venue: g.venue,
    status: g.status,
    current_period: g.current_period,
    score_pfc: g.score_pfc,
    score_opp: g.score_opp,
    created_at: g.created_at,
    logger_url: `${origin}/logger.html?gameId=${g.game_id}&token=${g.logger_token}`,
    scoreboard_url: `${origin}/scoreboard.html?gameId=${g.game_id}&token=${g.viewer_token}`,
  }));
  res.json(result);
});

// ── Get game state (both tokens accepted) ─────────────────────────────────────

app.get('/api/games/:gameId', (req, res) => {
  const { gameId } = req.params;
  const { token } = req.query;

  const game = db.getGame(gameId);
  if (!game) return res.status(404).json({ error: 'game not found' });
  if (token !== game.logger_token && token !== game.viewer_token) {
    return res.status(403).json({ error: 'invalid token' });
  }

  const events = db.getEvents(gameId);
  res.json({ game, events });
});

// ── Logger: control actions (logger token only) ───────────────────────────────

app.post('/api/games/:gameId/control', (req, res) => {
  const { gameId } = req.params;
  const { token, action, clock_seconds } = req.body;

  const game = db.getGame(gameId);
  if (!game) return res.status(404).json({ error: 'game not found' });
  if (token !== game.logger_token) return res.status(403).json({ error: 'invalid token' });

  const clk = typeof clock_seconds === 'number' ? clock_seconds : game.clock_seconds;

  switch (action) {
    case 'start_h1':
      if (game.status !== 'pending') {
        return res.status(400).json({ error: 'game already started' });
      }
      db.updateGame(gameId, { status: 'live', current_period: 'H1', clock_seconds: 0 });
      break;

    case 'start_h2':
      if (game.current_period !== 'H1') {
        return res.status(400).json({ error: 'not currently in H1' });
      }
      db.updateGame(gameId, { current_period: 'H2', clock_seconds: 0 });
      break;

    case 'end_game':
      if (game.status !== 'live') {
        return res.status(400).json({ error: 'game is not live' });
      }
      db.updateGame(gameId, { status: 'final', current_period: 'FT', clock_seconds: clk });
      break;

    case 'tick':
      // Periodic clock sync from logger (fire-and-forget)
      if (game.status === 'live') {
        db.updateGame(gameId, { clock_seconds: clk });
      }
      break;

    default:
      return res.status(400).json({ error: `unknown action: ${action}` });
  }

  const { game: updatedGame, events } = gameState(gameId);
  broadcast(gameId, { type: 'state_update', game: updatedGame, events });
  res.json({ game: updatedGame, events });
});

// ── Logger: log event (logger token only) ─────────────────────────────────────

app.post('/api/games/:gameId/events', (req, res) => {
  const { gameId } = req.params;
  const { token, event_code, clock_seconds } = req.body;

  const game = db.getGame(gameId);
  if (!game) return res.status(404).json({ error: 'game not found' });
  if (token !== game.logger_token) return res.status(403).json({ error: 'invalid token' });
  if (game.status !== 'live') return res.status(400).json({ error: 'game is not live' });

  if (!VALID_CODES.has(event_code)) {
    return res.status(400).json({ error: `invalid event_code: ${event_code}` });
  }

  const existingEvents = db.getEvents(gameId);
  const clk = typeof clock_seconds === 'number' ? clock_seconds : game.clock_seconds;

  const event = {
    event_id: `ev_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    game_id: gameId,
    sequence_number: existingEvents.length + 1,
    period: game.current_period,
    clock_seconds: clk,
    event_code,
    created_at: new Date().toISOString(),
    source_role: 'logger',
  };

  db.addEvent(event);

  const { game: updatedGame, events } = gameState(gameId);
  broadcast(gameId, { type: 'state_update', game: updatedGame, events });
  res.json({ event, game: updatedGame, events });
});

// ── Logger: undo last event (logger token only) ───────────────────────────────

app.delete('/api/games/:gameId/events/last', (req, res) => {
  const { gameId } = req.params;
  const { token } = req.query;

  const game = db.getGame(gameId);
  if (!game) return res.status(404).json({ error: 'game not found' });
  if (token !== game.logger_token) return res.status(403).json({ error: 'invalid token' });

  const removed = db.undoLastEvent(gameId);
  if (!removed) return res.status(400).json({ error: 'nothing to undo' });

  const { game: updatedGame, events } = gameState(gameId);
  broadcast(gameId, { type: 'state_update', game: updatedGame, events });
  res.json({ removed, game: updatedGame, events });
});

// ── SSE: live scoreboard stream (both tokens accepted) ────────────────────────

app.get('/api/games/:gameId/stream', (req, res) => {
  const { gameId } = req.params;
  const { token } = req.query;

  const game = db.getGame(gameId);
  if (!game) return res.status(404).end();
  if (token !== game.logger_token && token !== game.viewer_token) {
    return res.status(403).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx proxy buffering
  res.flushHeaders();

  // Send current state immediately on connect
  const events = db.getEvents(gameId);
  res.write(`data: ${JSON.stringify({ type: 'state_update', game, events })}\n\n`);

  // Register client
  if (!sseClients.has(gameId)) sseClients.set(gameId, new Set());
  sseClients.get(gameId).add(res);

  // Keep-alive heartbeat (15s)
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch (_) {}
  }, 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.get(gameId)?.delete(res);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║       GameMomentsLive  v1.0          ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  Server:  http://localhost:${PORT}`);
  console.log(`  Admin:   http://localhost:${PORT}/admin.html`);
  console.log('');
});

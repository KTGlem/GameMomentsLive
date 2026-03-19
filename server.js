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

// ── Highlight: dedupe helpers ─────────────────────────────────────────────────

const HIGHLIGHT_MERGE_WINDOW = 8; // seconds; highlights within ±8s may be the same moment

/**
 * Union two pipe-delimited strings, deduplicating values.
 * e.g. unionPipe("7|9", "9|11") => "7|9|11"
 */
function unionPipe(a, b) {
  const vals = new Set([
    ...(a || '').split('|').filter(Boolean),
    ...(b || '').split('|').filter(Boolean),
  ]);
  return [...vals].join('|');
}

/**
 * Find an existing canonical highlight to merge a new submission into.
 * Returns the canonical record, or null if a new one should be created.
 *
 * Merge rules (all must hold):
 *   1. Same game_id (guaranteed by query)
 *   2. Clock within ±HIGHLIGHT_MERGE_WINDOW seconds
 *   3. PLUS at least one of:
 *      a. Overlapping player number(s)
 *      b. Overlapping highlight reason(s)
 *      c. Submission is sparse (no players, no reasons) — typical for logger highlights
 *      d. Canonical is sparse — allow richer parent submission to attach to it
 *
 * The goal is to let a logger tap (sparse) merge with a parent submission (rich)
 * when they are close in time, even if the logger provided no metadata.
 */
function findMergeCandidate(gameId, clockEst, playerNumbers, highlightReasons) {
  const candidates = db.getCanonicalHighlights(gameId);
  const subPlayers = (playerNumbers || '').split('|').filter(Boolean);
  const subReasons = (highlightReasons || '').split('|').filter(Boolean);
  const isSparse   = subPlayers.length === 0 && subReasons.length === 0;

  for (const c of candidates) {
    // Must be within the merge time window
    const timeDiff = Math.abs(c.clock_seconds_estimate - clockEst);
    if (timeDiff > HIGHLIGHT_MERGE_WINDOW) continue;

    const canPlayers = (c.player_numbers || '').split('|').filter(Boolean);
    const canReasons = (c.highlight_reasons || '').split('|').filter(Boolean);
    const canSparse  = canPlayers.length === 0 && canReasons.length === 0;

    const playerOverlap = subPlayers.some(p => canPlayers.includes(p));
    const reasonOverlap = subReasons.some(r => canReasons.includes(r));

    // Merge if metadata overlaps, or if either side has no metadata to compare
    if (playerOverlap || reasonOverlap || isSparse || canSparse) {
      return c;
    }
  }
  return null;
}

/**
 * Process a highlight submission: find or create a canonical highlight,
 * then link the submission to it. Returns the canonical record.
 */
function processHighlightSubmission(submission) {
  const {
    submission_id, game_id, source_role, period,
    clock_seconds_estimate, player_numbers, highlight_reasons, note,
  } = submission;

  const ts  = new Date().toISOString();
  const clk = clock_seconds_estimate;

  const match = findMergeCandidate(game_id, clk, player_numbers, highlight_reasons);

  let canonicalId;

  if (match) {
    // ── Merge into existing canonical ──────────────────────────────────────
    canonicalId = match.highlight_id;
    db.updateCanonicalHighlight(canonicalId, {
      source_roles:      unionPipe(match.source_roles, source_role),
      player_numbers:    unionPipe(match.player_numbers, player_numbers),
      highlight_reasons: unionPipe(match.highlight_reasons, highlight_reasons),
      vote_count:        match.vote_count + 1,
      // Simple note merge: append new note if provided
      note_summary: match.note_summary
        ? (note ? `${match.note_summary} | ${note}` : match.note_summary)
        : (note || ''),
    });
  } else {
    // ── Create new canonical highlight ─────────────────────────────────────
    canonicalId = `hl_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    db.createCanonicalHighlight({
      highlight_id:           canonicalId,
      game_id,
      period,
      clock_seconds_estimate: clk,
      clip_start:             Math.max(0, clk - 8),   // default: 8s before moment
      clip_end:               clk + 12,                // default: 12s after moment
      source_roles:           source_role,
      player_numbers:         player_numbers || '',
      highlight_reasons:      highlight_reasons || '',
      vote_count:             1,
      note_summary:           note || '',
      created_at:             ts,
      updated_at:             ts,
    });
  }

  // Link the raw submission to its canonical highlight
  db.linkSubmissionToCanonical(submission_id, canonicalId);

  return db.getCanonicalHighlight(canonicalId);
}

// ── Highlight: logger submits (logger token only) ─────────────────────────────

app.post('/api/games/:gameId/highlights/logger', (req, res) => {
  const { gameId } = req.params;
  const { token, period, clock_seconds_estimate, note } = req.body;

  const game = db.getGame(gameId);
  if (!game) return res.status(404).json({ error: 'game not found' });
  if (token !== game.logger_token) return res.status(403).json({ error: 'invalid token' });

  const clk = typeof clock_seconds_estimate === 'number'
    ? clock_seconds_estimate
    : (game.clock_seconds || 0);

  const submission = {
    submission_id:          `sub_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    game_id:                gameId,
    source_role:            'logger',
    period:                 period || game.current_period || '',
    clock_seconds_estimate: clk,
    player_numbers:         '',   // logger highlights carry no player/reason metadata
    highlight_reasons:      '',
    note:                   (note || '').trim(),
    created_at:             new Date().toISOString(),
  };

  db.createHighlightSubmission(submission);
  const canonical = processHighlightSubmission(submission);

  res.json({ submission, canonical });
});

// ── Highlight: parent submits (viewer token only) ─────────────────────────────

app.post('/api/games/:gameId/highlights/parent', (req, res) => {
  const { gameId } = req.params;
  const { token, period, clock_seconds_estimate, player_numbers, highlight_reasons, note } = req.body;

  const game = db.getGame(gameId);
  if (!game) return res.status(404).json({ error: 'game not found' });
  if (token !== game.viewer_token) return res.status(403).json({ error: 'invalid token' });

  // Normalise pipe-delimited fields; also accept plain arrays from the client
  function normPipe(val) {
    if (!val) return '';
    if (Array.isArray(val)) return val.map(String).filter(Boolean).join('|');
    return String(val).split('|').map(s => s.trim()).filter(Boolean).join('|');
  }

  const clk = typeof clock_seconds_estimate === 'number'
    ? clock_seconds_estimate
    : (game.clock_seconds || 0);

  const submission = {
    submission_id:          `sub_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    game_id:                gameId,
    source_role:            'parent',
    period:                 period || game.current_period || '',
    clock_seconds_estimate: clk,
    player_numbers:         normPipe(player_numbers),
    highlight_reasons:      normPipe(highlight_reasons),
    note:                   (note || '').trim(),
    created_at:             new Date().toISOString(),
  };

  db.createHighlightSubmission(submission);
  const canonical = processHighlightSubmission(submission);

  res.json({ submission, canonical });
});

// ── Highlight: fetch canonical highlights (both tokens) ───────────────────────

app.get('/api/games/:gameId/highlights', (req, res) => {
  const { gameId } = req.params;
  const { token } = req.query;

  const game = db.getGame(gameId);
  if (!game) return res.status(404).json({ error: 'game not found' });
  if (token !== game.logger_token && token !== game.viewer_token) {
    return res.status(403).json({ error: 'invalid token' });
  }

  const highlights = db.getCanonicalHighlights(gameId);
  res.json({ highlights });
});

// ── Highlight: fetch raw submissions (both tokens) ────────────────────────────

app.get('/api/games/:gameId/highlights/submissions', (req, res) => {
  const { gameId } = req.params;
  const { token } = req.query;

  const game = db.getGame(gameId);
  if (!game) return res.status(404).json({ error: 'game not found' });
  if (token !== game.logger_token && token !== game.viewer_token) {
    return res.status(403).json({ error: 'invalid token' });
  }

  const submissions = db.getHighlightSubmissions(gameId);
  res.json({ submissions });
});

// ── Export: canonical highlights as CSV (both tokens) ─────────────────────────

app.get('/api/games/:gameId/export/highlights.csv', (req, res) => {
  const { gameId } = req.params;
  const { token } = req.query;

  const game = db.getGame(gameId);
  if (!game) return res.status(404).json({ error: 'game not found' });
  if (token !== game.logger_token && token !== game.viewer_token) {
    return res.status(403).json({ error: 'invalid token' });
  }

  const highlights = db.getCanonicalHighlights(gameId);
  const cols = [
    'highlight_id', 'game_id', 'period', 'clock_seconds_estimate',
    'clip_start', 'clip_end', 'source_roles', 'player_numbers',
    'highlight_reasons', 'vote_count', 'note_summary', 'created_at', 'updated_at',
  ];

  const csvEsc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows   = [cols.join(',')];
  for (const h of highlights) rows.push(cols.map(c => csvEsc(h[c])).join(','));

  const filename = `highlights_${gameId}_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(rows.join('\r\n'));
});

// ── Export: raw highlight submissions as CSV (both tokens) ────────────────────

app.get('/api/games/:gameId/export/submissions.csv', (req, res) => {
  const { gameId } = req.params;
  const { token } = req.query;

  const game = db.getGame(gameId);
  if (!game) return res.status(404).json({ error: 'game not found' });
  if (token !== game.logger_token && token !== game.viewer_token) {
    return res.status(403).json({ error: 'invalid token' });
  }

  const submissions = db.getHighlightSubmissions(gameId);
  const cols = [
    'submission_id', 'game_id', 'source_role', 'period', 'clock_seconds_estimate',
    'player_numbers', 'highlight_reasons', 'note', 'canonical_highlight_id', 'created_at',
  ];

  const csvEsc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows   = [cols.join(',')];
  for (const s of submissions) rows.push(cols.map(c => csvEsc(s[c])).join(','));

  const filename = `submissions_${gameId}_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(rows.join('\r\n'));
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

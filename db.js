'use strict';

// Uses Node.js 22.5+ built-in SQLite — no native compilation required.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'gamemoments.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    game_id         TEXT PRIMARY KEY,
    date            TEXT NOT NULL,
    team_name       TEXT NOT NULL DEFAULT 'PFC',
    opponent        TEXT NOT NULL,
    venue           TEXT DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'pending',
    current_period  TEXT NOT NULL DEFAULT 'PRE',
    clock_seconds   INTEGER NOT NULL DEFAULT 0,
    score_pfc       INTEGER NOT NULL DEFAULT 0,
    score_opp       INTEGER NOT NULL DEFAULT 0,
    logger_token    TEXT NOT NULL,
    viewer_token    TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    event_id        TEXT PRIMARY KEY,
    game_id         TEXT NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL,
    period          TEXT NOT NULL,
    clock_seconds   INTEGER NOT NULL DEFAULT 0,
    event_code      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    source_role     TEXT NOT NULL DEFAULT 'logger'
  );

  CREATE INDEX IF NOT EXISTS idx_events_game_id ON events(game_id);
  CREATE INDEX IF NOT EXISTS idx_games_logger_token ON games(logger_token);
  CREATE INDEX IF NOT EXISTS idx_games_viewer_token ON games(viewer_token);
`);

// ── Prepared statements ──────────────────────────────────────────────────────
// node:sqlite uses $name for named parameters

const stmts = {
  createGame: db.prepare(`
    INSERT INTO games
      (game_id, date, team_name, opponent, venue, logger_token, viewer_token, created_at, updated_at)
    VALUES
      ($game_id, $date, $team_name, $opponent, $venue, $logger_token, $viewer_token, $created_at, $updated_at)
  `),

  getGame:  db.prepare('SELECT * FROM games WHERE game_id = $id'),
  listGames: db.prepare('SELECT * FROM games ORDER BY created_at DESC LIMIT 20'),

  getEvents: db.prepare(
    'SELECT * FROM events WHERE game_id = $game_id ORDER BY sequence_number ASC'
  ),

  createEvent: db.prepare(`
    INSERT INTO events
      (event_id, game_id, sequence_number, period, clock_seconds, event_code, created_at, source_role)
    VALUES
      ($event_id, $game_id, $sequence_number, $period, $clock_seconds, $event_code, $created_at, $source_role)
  `),

  getLastEvent: db.prepare(
    'SELECT * FROM events WHERE game_id = $game_id ORDER BY sequence_number DESC LIMIT 1'
  ),

  deleteEvent: db.prepare('DELETE FROM events WHERE event_id = $event_id'),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function now() { return new Date().toISOString(); }

// ── Exported API ─────────────────────────────────────────────────────────────

module.exports = {
  createGame(data) {
    const ts = now();
    stmts.createGame.run({
      $game_id:      data.game_id,
      $date:         data.date,
      $team_name:    data.team_name,
      $opponent:     data.opponent,
      $venue:        data.venue,
      $logger_token: data.logger_token,
      $viewer_token: data.viewer_token,
      $created_at:   ts,
      $updated_at:   ts,
    });
  },

  getGame(gameId) {
    return stmts.getGame.get({ $id: gameId }) || null;
  },

  listGames() {
    return stmts.listGames.all({});
  },

  updateGame(gameId, fields) {
    const ts   = now();
    const cols = Object.keys(fields).map(k => `${k} = $${k}`).join(', ');
    const params = {};
    for (const [k, v] of Object.entries(fields)) params[`$${k}`] = v;
    params.$updated_at = ts;
    params.$game_id    = gameId;
    db.prepare(`UPDATE games SET ${cols}, updated_at = $updated_at WHERE game_id = $game_id`)
      .run(params);
  },

  getEvents(gameId) {
    return stmts.getEvents.all({ $game_id: gameId });
  },

  addEvent(event) {
    // Run as a manual transaction: insert event + update score/clock atomically
    db.exec('BEGIN');
    try {
      stmts.createEvent.run({
        $event_id:        event.event_id,
        $game_id:         event.game_id,
        $sequence_number: event.sequence_number,
        $period:          event.period,
        $clock_seconds:   event.clock_seconds,
        $event_code:      event.event_code,
        $created_at:      event.created_at,
        $source_role:     event.source_role,
      });

      const ts = now();
      if (event.event_code === 'goal_pfc') {
        db.prepare(`
          UPDATE games SET score_pfc = score_pfc + 1, clock_seconds = $clk, updated_at = $ts
          WHERE game_id = $id
        `).run({ $clk: event.clock_seconds, $ts: ts, $id: event.game_id });
      } else if (event.event_code === 'goal_opp') {
        db.prepare(`
          UPDATE games SET score_opp = score_opp + 1, clock_seconds = $clk, updated_at = $ts
          WHERE game_id = $id
        `).run({ $clk: event.clock_seconds, $ts: ts, $id: event.game_id });
      } else {
        db.prepare(`
          UPDATE games SET clock_seconds = $clk, updated_at = $ts WHERE game_id = $id
        `).run({ $clk: event.clock_seconds, $ts: ts, $id: event.game_id });
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },

  undoLastEvent(gameId) {
    db.exec('BEGIN');
    try {
      const event = stmts.getLastEvent.get({ $game_id: gameId });
      if (!event) {
        db.exec('ROLLBACK');
        return null;
      }

      stmts.deleteEvent.run({ $event_id: event.event_id });

      const ts = now();
      if (event.event_code === 'goal_pfc') {
        db.prepare(`
          UPDATE games SET score_pfc = MAX(0, score_pfc - 1), updated_at = $ts WHERE game_id = $id
        `).run({ $ts: ts, $id: gameId });
      } else if (event.event_code === 'goal_opp') {
        db.prepare(`
          UPDATE games SET score_opp = MAX(0, score_opp - 1), updated_at = $ts WHERE game_id = $id
        `).run({ $ts: ts, $id: gameId });
      } else {
        db.prepare('UPDATE games SET updated_at = $ts WHERE game_id = $id')
          .run({ $ts: ts, $id: gameId });
      }

      db.exec('COMMIT');
      return event;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },
};

// HALCYON - settings store SQLite (Node server :8443).
// Persistenza locale del profilo utente: userId UUID v4 -> JSON blob arbitrario.
// File: data/app.db. Schema versionato, migration idempotente.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SCHEMA_VERSION = 1;
const MAX_JSON_BYTES = 64 * 1024; // 64 KB per utente: avatar 96x96 + preferences

export class SettingsStore {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._migrate();
    this._stmtGet = this.db.prepare('SELECT json, updated_at FROM settings WHERE user_id = ?');
    this._stmtUpsert = this.db.prepare(`
      INSERT INTO settings (user_id, json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `);
    this._stmtDelete = this.db.prepare('DELETE FROM settings WHERE user_id = ?');
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (
        user_id    TEXT PRIMARY KEY,
        json       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const row = this.db.prepare('SELECT v FROM schema_meta WHERE k = ?').get('version');
    if (!row) {
      this.db
        .prepare('INSERT INTO schema_meta (k, v) VALUES (?, ?)')
        .run('version', SCHEMA_VERSION);
    }
  }

  /**
   * Ritorna il profilo per userId, o null se non esiste.
   * @returns {{ userId: string, settings: object, updatedAt: number } | null}
   */
  get(userId) {
    if (!isValidUserId(userId)) return null;
    const row = this._stmtGet.get(userId);
    if (!row) return null;
    try {
      return { userId, settings: JSON.parse(row.json), updatedAt: row.updated_at };
    } catch {
      return null;
    }
  }

  /**
   * Upsert del profilo. Valida userId e dimensione JSON.
   * @throws Error se input invalido.
   */
  put(userId, settings) {
    if (!isValidUserId(userId)) throw new Error('invalid_user_id');
    if (typeof settings !== 'object' || settings === null) throw new Error('invalid_settings');
    const json = JSON.stringify(settings);
    if (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) throw new Error('settings_too_large');
    this._stmtUpsert.run(userId, json, Date.now());
    return { userId, settings, updatedAt: Date.now() };
  }

  delete(userId) {
    if (!isValidUserId(userId)) return false;
    const info = this._stmtDelete.run(userId);
    return info.changes > 0;
  }

  size() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
  }

  close() {
    this.db.close();
  }
}

/**
 * Valida UUID v4 case-insensitive (RFC 4122). Accetta anche prefisso "sess-..."
 * per i fallback di Math.random nel client.
 */
export function isValidUserId(id) {
  if (typeof id !== 'string') return false;
  if (id.length > 80) return false;
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    /^sess-[a-z0-9]{10,40}$/i.test(id)
  );
}

export function defaultDbPath() {
  return join(process.cwd(), 'data', 'app.db');
}

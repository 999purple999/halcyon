// HALCYON — soundboard storage.
//
// Sound files live as binary blobs on disk under data/sounds/. The SQLite row
// keeps the metadata (id, name, mime, size, owner, ts) and points at the file
// by id. Files are written via writeFileSync at upload time; reads are stream-
// based via fs.createReadStream to avoid loading huge blobs into memory.
//
// Hard caps: 5 MB per sound, 64 char display name, 200 sounds per owner.
// These exist to keep the LAN-first promise small: nothing here is a generic
// CDN, it's a tiny shared clipboard for short Opus clips.

import Database from 'better-sqlite3';
import {
  mkdirSync,
  writeFileSync,
  unlinkSync,
  statSync,
  existsSync,
  createReadStream,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SOUND_SCHEMA_VERSION = 1;
export const SOUND_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const SOUND_MAX_NAME = 64;
export const SOUND_MAX_PER_OWNER = 200;

export class SoundStore {
  constructor(dbPath, soundsDir) {
    mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(soundsDir, { recursive: true });
    this.soundsDir = soundsDir;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._migrate();
    this._stmtInsert = this.db.prepare(`
      INSERT INTO sounds (id, name, mime, size, owner_id, owner_name, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmtList = this.db.prepare(
      'SELECT id, name, mime, size, owner_id, owner_name, ts FROM sounds ORDER BY ts DESC LIMIT 500',
    );
    this._stmtGet = this.db.prepare(
      'SELECT id, name, mime, size, owner_id, owner_name, ts FROM sounds WHERE id = ?',
    );
    this._stmtDelete = this.db.prepare('DELETE FROM sounds WHERE id = ? AND owner_id = ?');
    this._stmtCountForOwner = this.db.prepare(
      'SELECT COUNT(*) AS n FROM sounds WHERE owner_id = ?',
    );
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sounds_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sounds (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        mime        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        owner_id    TEXT NOT NULL,
        owner_name  TEXT NOT NULL,
        ts          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sounds_ts ON sounds(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_sounds_owner ON sounds(owner_id);
    `);
    const row = this.db.prepare('SELECT v FROM sounds_meta WHERE k = ?').get('version');
    if (!row) {
      this.db
        .prepare('INSERT INTO sounds_meta (k, v) VALUES (?, ?)')
        .run('version', SOUND_SCHEMA_VERSION);
    }
  }

  filePathFor(id) {
    return join(this.soundsDir, id);
  }

  /**
   * Persist an uploaded sound. Caller is responsible for validating ownerId.
   * @param {{name:string, mime:string, ownerId:string, ownerName:string, buffer:Buffer}} sound
   * @returns {{id:string, name:string, mime:string, size:number, ownerId:string, ownerName:string, ts:number}}
   */
  upload(sound) {
    const name =
      String(sound.name || 'untitled')
        .trim()
        .slice(0, SOUND_MAX_NAME) || 'untitled';
    const mime = String(sound.mime || 'application/octet-stream').slice(0, 80);
    const buf = sound.buffer;
    if (!buf || !buf.length) throw new Error('empty_buffer');
    if (buf.length > SOUND_MAX_BYTES) throw new Error('too_large');
    const ownerId = String(sound.ownerId || '').slice(0, 64);
    if (!ownerId) throw new Error('owner_required');
    const ownerName = String(sound.ownerName || 'unknown').slice(0, 32);
    const count = this._stmtCountForOwner.get(ownerId).n;
    if (count >= SOUND_MAX_PER_OWNER) throw new Error('quota_exceeded');
    const id = randomUUID();
    const ts = Date.now();
    writeFileSync(this.filePathFor(id), buf);
    this._stmtInsert.run(id, name, mime, buf.length, ownerId, ownerName, ts);
    return { id, name, mime, size: buf.length, ownerId, ownerName, ts };
  }

  list() {
    return this._stmtList.all().map((r) => ({
      id: r.id,
      name: r.name,
      mime: r.mime,
      size: r.size,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      ts: r.ts,
    }));
  }

  get(id) {
    const r = this._stmtGet.get(id);
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      mime: r.mime,
      size: r.size,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      ts: r.ts,
    };
  }

  exists(id) {
    const fp = this.filePathFor(id);
    try {
      return existsSync(fp);
    } catch {
      return false;
    }
  }

  /** Returns a readable stream of the file body for HTTP responses. */
  readStream(id) {
    return createReadStream(this.filePathFor(id));
  }

  /** Returns the actual on-disk size, useful for the Content-Length header. */
  diskSize(id) {
    try {
      return statSync(this.filePathFor(id)).size;
    } catch {
      return 0;
    }
  }

  /**
   * Delete a sound (DB row + file). Only succeeds if ownerId matches the row's
   * owner_id, so callers can safely pass user-provided ownerId without further
   * checks.
   * @returns {boolean} true if a row was removed and the file unlinked.
   */
  delete(id, ownerId) {
    const r = this._stmtGet.get(id);
    if (!r) return false;
    if (r.owner_id !== ownerId) return false;
    const res = this._stmtDelete.run(id, ownerId);
    if (!res.changes) return false;
    try {
      unlinkSync(this.filePathFor(id));
    } catch {
      /* file already gone; row was the source of truth */
    }
    return true;
  }
}

// HALCYON - chat store SQLite ().
// Storage messaggi per-stanza con history persistente. Schema versionato,
// FTS5 disabilitato per ora ( lo abilitera' per ricerca).
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const CHAT_SCHEMA_VERSION = 1;
const MAX_TEXT_BYTES = 16 * 1024; // 16 KB per messaggio
const MAX_NAME_LEN = 32;
const DEFAULT_ROOM = 'main';

export class ChatStore {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._migrate();
    this._stmtInsert = this.db.prepare(`
      INSERT INTO messages (id, room_id, from_id, from_name, ts, text, reply_to)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmtHistory = this.db.prepare(`
      SELECT id, room_id, from_id, from_name, ts, text, reply_to, edited_at, deleted_at
      FROM messages
      WHERE room_id = ? AND ts < ? AND deleted_at IS NULL
      ORDER BY ts DESC
      LIMIT ?
    `);
    this._stmtEdit = this.db.prepare(`
      UPDATE messages SET text = ?, edited_at = ?
      WHERE id = ? AND from_id = ? AND deleted_at IS NULL
    `);
    this._stmtDelete = this.db.prepare(`
      UPDATE messages SET deleted_at = ?
      WHERE id = ? AND from_id = ? AND deleted_at IS NULL
    `);
    this._stmtCountRoom = this.db.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND deleted_at IS NULL',
    );
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        room_id    TEXT NOT NULL,
        from_id    TEXT NOT NULL,
        from_name  TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        text       TEXT NOT NULL,
        reply_to   TEXT,
        edited_at  INTEGER,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room_id, ts DESC);
      CREATE TABLE IF NOT EXISTS reactions (
        msg_id  TEXT NOT NULL,
        user_id TEXT NOT NULL,
        emoji   TEXT NOT NULL,
        ts      INTEGER NOT NULL,
        PRIMARY KEY(msg_id, user_id, emoji)
      );
      CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(msg_id);
    `);
    const row = this.db.prepare('SELECT v FROM chat_meta WHERE k = ?').get('version');
    if (!row) {
      this.db
        .prepare('INSERT INTO chat_meta (k, v) VALUES (?, ?)')
        .run('version', CHAT_SCHEMA_VERSION);
    }
    this._stmtReactToggle = null; // lazy
  }

  // ---- reactions () ---------------------------------------------
  /**
   * Toggle reaction (add se non presente, remove se gia' presente).
   * @returns {'added'|'removed'}
   */
  toggleReaction({ msgId, userId, emoji }) {
    if (typeof msgId !== 'string' || !msgId) throw new Error('invalid_msg_id');
    if (typeof userId !== 'string' || !userId) throw new Error('invalid_user_id');
    if (typeof emoji !== 'string' || !emoji || emoji.length > 16) throw new Error('invalid_emoji');
    const existing = this.db
      .prepare('SELECT 1 FROM reactions WHERE msg_id = ? AND user_id = ? AND emoji = ?')
      .get(msgId, userId, emoji);
    if (existing) {
      this.db
        .prepare('DELETE FROM reactions WHERE msg_id = ? AND user_id = ? AND emoji = ?')
        .run(msgId, userId, emoji);
      return 'removed';
    }
    this.db
      .prepare('INSERT INTO reactions (msg_id, user_id, emoji, ts) VALUES (?, ?, ?, ?)')
      .run(msgId, userId, emoji, Date.now());
    return 'added';
  }

  /** Aggregato { emoji: { count, users: [userId, ...] } } per un msgId. */
  reactionsFor(msgId) {
    const rows = this.db
      .prepare('SELECT emoji, user_id FROM reactions WHERE msg_id = ? ORDER BY ts ASC')
      .all(msgId);
    const out = {};
    for (const r of rows) {
      if (!out[r.emoji]) out[r.emoji] = { count: 0, users: [] };
      out[r.emoji].count++;
      out[r.emoji].users.push(r.user_id);
    }
    return out;
  }

  /**
   * Inserisce un nuovo messaggio.
   * @returns Il messaggio salvato con id generato.
   */
  send({ roomId = DEFAULT_ROOM, fromId, fromName, text, replyTo = null }) {
    if (typeof fromId !== 'string' || !fromId) throw new Error('invalid_from_id');
    if (typeof text !== 'string' || !text.trim()) throw new Error('invalid_text');
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('text_too_large');
    const safeName = String(fromName || 'Anonimo').slice(0, MAX_NAME_LEN);
    const id = 'm_' + randomUUID();
    const ts = Date.now();
    this._stmtInsert.run(id, roomId, fromId, safeName, ts, text, replyTo);
    return { id, roomId, fromId, fromName: safeName, ts, text, replyTo };
  }

  /**
   * Ritorna gli ultimi `limit` messaggi della stanza (più recenti per primi),
   * con cursor opzionale `before` (timestamp ms).
   */
  history({ roomId = DEFAULT_ROOM, before = Date.now() + 1, limit = 50 } = {}) {
    if (limit > 200) limit = 200;
    const rows = this._stmtHistory.all(roomId, before, limit);
    return rows.map((r) => ({
      id: r.id,
      roomId: r.room_id,
      fromId: r.from_id,
      fromName: r.from_name,
      ts: r.ts,
      text: r.text,
      replyTo: r.reply_to,
      editedAt: r.edited_at,
      reactions: this.reactionsFor(r.id),
    }));
  }

  /**
   * Edit del messaggio. Solo l'autore originale.
   * @returns true se modificato, false se non trovato/non autorizzato.
   */
  edit({ id, fromId, text }) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('invalid_text');
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('text_too_large');
    const info = this._stmtEdit.run(text, Date.now(), id, fromId);
    return info.changes > 0;
  }

  /** Soft-delete. */
  delete({ id, fromId }) {
    const info = this._stmtDelete.run(Date.now(), id, fromId);
    return info.changes > 0;
  }

  countRoom(roomId = DEFAULT_ROOM) {
    return this._stmtCountRoom.get(roomId).n;
  }

  close() {
    this.db.close();
  }
}

export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/**
 * Markdown minimale -> HTML: bold **, italic *, inline code `, code block ```,
 * link [t](u), mention @name. Input pre-escaped via escapeHtml; ogni output
 * resta sicuro per innerHTML.
 */
export function renderMarkdown(input) {
  let s = escapeHtml(String(input || ''));
  // code block ``` ... ```
  s = s.replace(/```([\s\S]+?)```/g, (_, body) => `<pre><code>${body}</code></pre>`);
  // inline code `...`
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // bold **text**
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // italic *text*
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '<em>$1</em>');
  // link [text](url) - url validato (http/https/mailto) per sicurezza
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, t, u) => {
    return `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`;
  });
  // mention @nome
  s = s.replace(/(^|\s)@([a-zA-Z0-9_]{1,32})/g, '$1<span class="mention">@$2</span>');
  // newline -> <br>
  s = s.replace(/\n/g, '<br>');
  return s;
}

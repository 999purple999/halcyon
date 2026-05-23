// HALCYON unit (vitest) - SettingsStore SQLite ().
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SettingsStore, isValidUserId } from '../../lib/settings_store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const UID_OK = 'c5cb1234-abcd-4ef0-9000-000000000001';
const UID_SESS = 'sess-abc1234xyz789';
const UID_BAD = 'NOT-A-UUID';

describe('isValidUserId', () => {
  it('accetta UUID v4 lowercase', () => {
    expect(isValidUserId(UID_OK)).toBe(true);
  });
  it('accetta UUID v4 uppercase', () => {
    expect(isValidUserId(UID_OK.toUpperCase())).toBe(true);
  });
  it('accetta fallback sess-... base36', () => {
    expect(isValidUserId(UID_SESS)).toBe(true);
  });
  it('rifiuta stringa generica', () => {
    expect(isValidUserId(UID_BAD)).toBe(false);
  });
  it('rifiuta UUID v3 (4-deve essere v4)', () => {
    expect(isValidUserId('c5cb1234-abcd-3ef0-9000-000000000001')).toBe(false);
  });
  it('rifiuta non-string', () => {
    expect(isValidUserId(null)).toBe(false);
    expect(isValidUserId(undefined)).toBe(false);
    expect(isValidUserId(42)).toBe(false);
  });
  it('rifiuta troppo lunga', () => {
    expect(isValidUserId('a'.repeat(100))).toBe(false);
  });
});

describe('SettingsStore', () => {
  let dir;
  let store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'halcyon-test-'));
    store = new SettingsStore(join(dir, 'app.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('get su userId mancante ritorna null', () => {
    expect(store.get(UID_OK)).toBe(null);
  });

  it('put + get roundtrip preserva i dati', () => {
    const settings = { nickname: 'Alice', aecOn: true, theme: 'matrix' };
    const row = store.put(UID_OK, settings);
    expect(row.userId).toBe(UID_OK);
    expect(row.settings).toEqual(settings);
    const got = store.get(UID_OK);
    expect(got.userId).toBe(UID_OK);
    expect(got.settings).toEqual(settings);
    expect(got.updatedAt).toBeGreaterThan(0);
  });

  it('put è upsert (sovrascrive)', () => {
    store.put(UID_OK, { nickname: 'A' });
    store.put(UID_OK, { nickname: 'B' });
    expect(store.get(UID_OK).settings.nickname).toBe('B');
    expect(store.size()).toBe(1);
  });

  it('delete rimuove il profilo', () => {
    store.put(UID_OK, { nickname: 'Alice' });
    expect(store.delete(UID_OK)).toBe(true);
    expect(store.get(UID_OK)).toBe(null);
    expect(store.delete(UID_OK)).toBe(false); // gia eliminato
  });

  it('rifiuta userId invalido in put', () => {
    expect(() => store.put(UID_BAD, { x: 1 })).toThrow('invalid_user_id');
  });

  it('rifiuta settings non-object', () => {
    expect(() => store.put(UID_OK, null)).toThrow('invalid_settings');
    expect(() => store.put(UID_OK, 'string')).toThrow('invalid_settings');
  });

  it('rifiuta settings >64KB', () => {
    const big = { blob: 'x'.repeat(70_000) };
    expect(() => store.put(UID_OK, big)).toThrow('settings_too_large');
  });

  it('size() conta profili', () => {
    expect(store.size()).toBe(0);
    store.put(UID_OK, { a: 1 });
    store.put(UID_SESS, { b: 2 });
    expect(store.size()).toBe(2);
  });

  it('persiste su disco fra istanze (WAL)', () => {
    const path = store.db.name;
    store.put(UID_OK, { nickname: 'Alice' });
    store.close();
    store = new SettingsStore(path);
    expect(store.get(UID_OK).settings.nickname).toBe('Alice');
  });
});

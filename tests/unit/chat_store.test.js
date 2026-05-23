// HALCYON unit (vitest) - ChatStore SQLite ().
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatStore, escapeHtml, renderMarkdown } from '../../lib/chat_store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const UID_A = 'c5cb1234-abcd-4ef0-9000-000000000010';
const UID_B = 'c5cb1234-abcd-4ef0-9000-000000000011';

describe('escapeHtml', () => {
  it('scappa caratteri pericolosi', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('a&b')).toBe('a&amp;b');
    expect(escapeHtml(`"' "`)).toBe('&quot;&#39; &quot;');
  });
});

describe('renderMarkdown', () => {
  it('bold + italic', () => {
    expect(renderMarkdown('**ciao**')).toContain('<strong>ciao</strong>');
    expect(renderMarkdown('*ciao*')).toContain('<em>ciao</em>');
  });
  it('inline code + code block', () => {
    expect(renderMarkdown('`x`')).toContain('<code>x</code>');
    expect(renderMarkdown('```js\nlet a=1\n```')).toContain('<pre><code>');
  });
  it('link valido http/https/mailto', () => {
    expect(renderMarkdown('[ciao](https://example.com)')).toContain('href="https://example.com"');
    expect(renderMarkdown('[m](mailto:a@b.com)')).toContain('href="mailto:a@b.com"');
  });
  it('link malevolo javascript: rejected (no match)', () => {
    expect(renderMarkdown('[xss](javascript:alert(1))')).not.toContain('href="javascript');
  });
  it('mention @nome', () => {
    expect(renderMarkdown('ciao @alice come stai')).toContain(
      '<span class="mention">@alice</span>',
    );
  });
  it('escapa input prima del markdown', () => {
    expect(renderMarkdown('<img src=x>')).toContain('&lt;img');
  });
  it('newline -> br', () => {
    expect(renderMarkdown('a\nb')).toBe('a<br>b');
  });
});

describe('ChatStore', () => {
  let dir;
  let store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'halcyon-chat-'));
    store = new ChatStore(join(dir, 'chat.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('send + history roundtrip', () => {
    const m = store.send({ fromId: UID_A, fromName: 'Alice', text: 'ciao' });
    expect(m.id).toMatch(/^m_/);
    expect(m.fromId).toBe(UID_A);
    const h = store.history();
    expect(h.length).toBe(1);
    expect(h[0].text).toBe('ciao');
  });

  it('history ordina ts DESC', async () => {
    store.send({ fromId: UID_A, fromName: 'Alice', text: 'primo' });
    await new Promise((r) => setTimeout(r, 5));
    store.send({ fromId: UID_B, fromName: 'Bob', text: 'secondo' });
    const h = store.history({ limit: 10 });
    expect(h[0].text).toBe('secondo');
    expect(h[1].text).toBe('primo');
  });

  it('history limit cap 200', () => {
    for (let i = 0; i < 5; i++) store.send({ fromId: UID_A, fromName: 'A', text: 'x' + i });
    const h = store.history({ limit: 500 });
    expect(h.length).toBe(5);
  });

  it('send vuoto rejected', () => {
    expect(() => store.send({ fromId: UID_A, fromName: 'A', text: '' })).toThrow('invalid_text');
    expect(() => store.send({ fromId: UID_A, fromName: 'A', text: '   ' })).toThrow('invalid_text');
  });

  it('send text >16KB rejected', () => {
    const big = 'x'.repeat(20_000);
    expect(() => store.send({ fromId: UID_A, fromName: 'A', text: big })).toThrow('text_too_large');
  });

  it('edit solo dall-autore', () => {
    const m = store.send({ fromId: UID_A, fromName: 'A', text: 'old' });
    expect(store.edit({ id: m.id, fromId: UID_A, text: 'new' })).toBe(true);
    expect(store.edit({ id: m.id, fromId: UID_B, text: 'evil' })).toBe(false);
    expect(store.history()[0].text).toBe('new');
    expect(store.history()[0].editedAt).toBeGreaterThan(0);
  });

  it('delete soft (history esclude deleted)', () => {
    const m = store.send({ fromId: UID_A, fromName: 'A', text: 'x' });
    expect(store.delete({ id: m.id, fromId: UID_A })).toBe(true);
    expect(store.history()).toHaveLength(0);
    expect(store.countRoom()).toBe(0);
  });

  it('delete denied per altro user', () => {
    const m = store.send({ fromId: UID_A, fromName: 'A', text: 'x' });
    expect(store.delete({ id: m.id, fromId: UID_B })).toBe(false);
  });

  it('countRoom riflette messaggi vivi', () => {
    expect(store.countRoom()).toBe(0);
    store.send({ fromId: UID_A, fromName: 'A', text: 'm1' });
    store.send({ fromId: UID_A, fromName: 'A', text: 'm2' });
    expect(store.countRoom()).toBe(2);
  });

  it('history cursor before', async () => {
    const m1 = store.send({ fromId: UID_A, fromName: 'A', text: '1' });
    await new Promise((r) => setTimeout(r, 5));
    store.send({ fromId: UID_A, fromName: 'A', text: '2' });
    const h = store.history({ before: m1.ts + 1, limit: 10 });
    expect(h.length).toBe(1);
    expect(h[0].text).toBe('1');
  });
});

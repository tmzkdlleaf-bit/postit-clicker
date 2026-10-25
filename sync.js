// Supabase 동기화 — 프로그램 본체에서 씀
const fs = require('fs');
const path = require('path');
const C = require('./src/sync-core.js');

const SUPABASE_URL = 'https://hyumtlqzijwobfeaaefh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_nqp_5MLACVM2Wr4STEFFkg_P_2hkpWB'; // 공개용 키 (내 것만 보기 규칙으로 보호됨)

class Sync {
  /**
   * getData(): 지금 데이터, onRemote(info): 다른 기기 변경을 합친 뒤 불림, onStatus(status)
   */
  constructor({ dir, getData, onRemote, onStatus, url, key }) {
    this.dir = dir; this.getData = getData; this.onRemote = onRemote; this.onStatus = onStatus || (() => {});
    this.url = url || SUPABASE_URL; this.key = key || SUPABASE_KEY;
    this.metaFile = path.join(dir, 'sync-meta.json');
    this.authFile = path.join(dir, 'sync-auth.json');
    this.meta = C.normMeta(this._read(this.metaFile));
    this.status = { state: 'off', email: '', last: 0, error: '' };
    this.client = null; this.user = null; this.channel = null;
    this.pushTimer = null; this.retryTimer = null; this.pullTimer = null; this.pushing = false; this.again = false;
  }

  _read(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
  _write(f, o) { try { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); } catch (e) { console.warn('[동기화 저장 실패]', e.message); } }
  saveMeta() { C.prune(this.meta); this._write(this.metaFile, this.meta); }
  setStatus(p) { this.status = Object.assign({}, this.status, p); this.onStatus(this.status); }
  deletedIds() { return C.deletedIds(this.meta); }

  /* 로그인 정보는 프로그램 폴더 안 파일에 */
  _storage() {
    const self = this;
    return {
      getItem: k => { const o = self._read(self.authFile) || {}; return o[k] ?? null; },
      setItem: (k, v) => { const o = self._read(self.authFile) || {}; o[k] = v; self._write(self.authFile, o); },
      removeItem: k => { const o = self._read(self.authFile) || {}; delete o[k]; self._write(self.authFile, o); },
    };
  }

  async init() {
    const { createClient } = require('@supabase/supabase-js');
    let transport;
    try { transport = require('ws'); } catch (_) {}
    this.client = createClient(this.url, this.key, {
      auth: { storage: this._storage(), persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      realtime: transport ? { transport } : undefined,
    });
    C.ensureRevs(this.getData().state);
    const { data } = await this.client.auth.getSession();
    if (data && data.session) { this.user = data.session.user; await this.start(); }
    else this.setStatus({ state: 'off', email: '' });
    this.client.auth.onAuthStateChange((ev, session) => {
      if (ev === 'SIGNED_OUT') { this.user = null; this.stop(); this.setStatus({ state: 'off', email: '' }); }
      else if (session && ev === 'TOKEN_REFRESHED') this.user = session.user;
    });
  }

  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) return { error: korean(error) };
    this.user = data.user; await this.start();
    return { ok: true };
  }
  async signUp(email, password) {
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) return { error: korean(error) };
    if (!data.session) return { confirm: true }; // 확인 메일을 눌러야 함
    this.user = data.user; await this.start();
    return { ok: true };
  }
  async signOut() {
    try { await this.client.auth.signOut(); } catch (_) {}
    this.user = null; this.stop();
    // 다음에 다른 계정으로 들어갈 수 있으니 올림 기록은 비움 (내 데이터는 그대로)
    this.meta.pushed = {}; Object.values(this.meta.tomb).forEach(t => t.pushed = false); this.meta.settingsPushed = 0;
    this.saveMeta();
    this.setStatus({ state: 'off', email: '', error: '' });
  }

  async start() {
    this.setStatus({ state: 'syncing', email: this.user.email, error: '' });
    await this.pullAll();
    await this.pushNow();
    this.subscribe();
    clearInterval(this.pullTimer);
    this.pullTimer = setInterval(() => this.pullAll().then(() => this.pushNow()), 10 * 60e3); // 놓친 게 있을까 10분마다
  }
  stop() {
    clearTimeout(this.pushTimer); clearTimeout(this.retryTimer); clearInterval(this.pullTimer);
    if (this.channel) { try { this.client.removeChannel(this.channel); } catch (_) {} this.channel = null; }
  }

  /* 내 기기에서 바뀌었을 때 (본체가 부름) */
  localChange(oldState, newState, oldSettings, newSettings) {
    const a = C.stamp(oldState, newState, this.meta);
    const b = oldSettings && newSettings ? C.stampSettings(oldSettings, newSettings, this.meta) : false;
    if (a || b) { this.saveMeta(); this.schedulePush(); }
  }
  touchNote(n) { n.rev = Math.max(Date.now(), (n.rev || 0) + 1); this.saveMeta(); this.schedulePush(); }

  schedulePush() { if (!this.user) return; clearTimeout(this.pushTimer); this.pushTimer = setTimeout(() => this.pushNow(), 1200); }

  async pushNow() {
    if (!this.user) return;
    if (this.pushing) { this.again = true; return; }
    const d = this.getData();
    const p = C.collectPush(d.state, d.settings, this.meta);
    if (p.empty) { this.setStatus({ state: 'synced', last: Date.now() }); return; }
    this.pushing = true;
    this.setStatus({ state: 'syncing' });
    try {
      const { error } = await this.client.rpc('postit_push', { p_boards: p.boards, p_notes: p.notes, p_settings: p.settings });
      if (error) throw error;
      C.markPushed(this.meta, p); this.saveMeta();
      this.setStatus({ state: 'synced', last: Date.now(), error: '' });
    } catch (e) {
      this.setStatus({ state: 'offline', error: korean(e) });
      clearTimeout(this.retryTimer); this.retryTimer = setTimeout(() => this.pushNow(), 30e3);
    } finally {
      this.pushing = false;
      if (this.again) { this.again = false; this.schedulePush(); }
    }
  }

  async _all(table) {
    const out = []; const size = 1000;
    for (let from = 0; ; from += size) {
      const { data, error } = await this.client.from(table).select('*').range(from, from + size - 1);
      if (error) throw error;
      out.push(...data); if (data.length < size) break;
    }
    return out;
  }
  async pullAll() {
    if (!this.user) return;
    try {
      const [boards, notes, settings] = await Promise.all([this._all('postit_boards'), this._all('postit_notes'),
        this.client.from('postit_settings').select('*').maybeSingle().then(r => { if (r.error) throw r.error; return r.data; })]);
      this.apply({ boards, notes, settings });
      this.meta.lastPull = Date.now(); this.saveMeta();
    } catch (e) {
      this.setStatus({ state: 'offline', error: korean(e) });
    }
  }
  apply(remote) {
    const d = this.getData();
    const r = C.mergeRemote(d.state, d.settings, this.meta, remote);
    if (r.emptyBoards) { // 판이 하나도 안 남는 일은 막음
      d.state.boards.push({ id: Date.now().toString(36), name: '할 일', order: 0, kind: (d.settings.kinds[0] || {}).id || 'work', bg: { type: 'cork', color: '', image: '' }, rev: Date.now() });
      d.state.current = d.state.boards[0].id; this.schedulePush();
    }
    this.saveMeta();
    if (r.changed || r.settingsChanged) this.onRemote(r);
  }

  subscribe() {
    if (this.channel) { try { this.client.removeChannel(this.channel); } catch (_) {} }
    const uid = this.user.id, filter = `user_id=eq.${uid}`;
    const ch = this.client.channel('postit-' + uid);
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'postit_boards', filter }, p => p.new && p.new.id && this.apply({ boards: [p.new] }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'postit_notes', filter }, p => p.new && p.new.id && this.apply({ notes: [p.new] }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'postit_settings', filter }, p => p.new && p.new.user_id && this.apply({ settings: p.new }))
      .subscribe(st => {
        if (st === 'SUBSCRIBED') this.setStatus({ realtime: true });
        if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') {
          this.setStatus({ realtime: false });
          // 끊겼다 다시 이어지면 그 사이 바뀐 걸 통째로 받기
          clearTimeout(this._resub); this._resub = setTimeout(() => { if (this.user) this.pullAll().then(() => this.subscribe()); }, 15e3);
        }
      });
    this.channel = ch;
  }
}

function korean(e) {
  const m = String((e && (e.message || e.error_description)) || e || '');
  if (/Invalid login credentials/i.test(m)) return '이메일이나 비밀번호가 맞지 않아요.';
  if (/Email not confirmed/i.test(m)) return '확인 메일의 링크를 먼저 눌러주세요.';
  if (/already registered/i.test(m)) return '이미 가입된 이메일이에요. 로그인해 주세요.';
  if (/Password should be/i.test(m)) return '비밀번호는 6자 이상이어야 해요.';
  if (/fetch failed|network|ENOTFOUND|ECONN|timed out/i.test(m)) return '인터넷에 연결되지 않았어요.';
  if (/rate limit/i.test(m)) return '잠시 뒤에 다시 시도해 주세요.';
  return m || '알 수 없는 오류';
}

module.exports = Sync;

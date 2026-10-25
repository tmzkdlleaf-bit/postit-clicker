/* 포스트잇 공통 부품 — 판, 목록, 캐릭터, 설정 창과 프로그램 본체가 같이 씀 */
(function (root, factory) {
  const S = factory();
  if (typeof module === 'object' && module.exports) module.exports = S;
  else root.Shared = S;
})(typeof self !== 'undefined' ? self : this, function () {

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const now = () => new Date().toISOString();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const clone = o => JSON.parse(JSON.stringify(o));

  /* ---------- 기본값 ---------- */
  const DEFAULT_KINDS = [
    { id: 'work',  label: '일',   w: 3 },
    { id: 'study', label: '과제', w: 3 },
    { id: 'life',  label: '생활', w: 2 },
    { id: 'hobby', label: '취미', w: 1 },
  ];
  const LEVELS = [ // 판 종류·할 일 중요도에 쓰는 단계
    { w: 1, label: '낮음' }, { w: 2, label: '보통' }, { w: 3, label: '높음' }, { w: 4, label: '가장 높음' },
  ];
  const IMP = { high: { label: '중요', w: 4 }, mid: { label: '보통', w: 2.5 }, low: { label: '낮음', w: 1 } };

  const DEFAULT_KEYWORDS = {
    high: ['과제', '마감', '제출', '커미션', '회의', '시험', '납품', '업무', '보고서', '발표', '입금', '병원'],
    low:  ['게임', '덕질', '산책', '영화', '드라마', '취미', '쇼핑', '유튜브', '애니'],
  };

  // Radix Colors 4단계 (amber, pink, sky, grass, violet, orange, sand)
  const DEFAULT_PALETTE = ['#ffee9c', '#fbdcef', '#d5efff', '#d6f1df', '#e4defc', '#ffdfb5', '#f1f0ef'];

  const DEFAULT_LINES = {
    click:   ['딸깍.', '오늘 할 일 봤어?', '하나만 끝내고 쉬자.', '물 마셨어?'],
    urgent:  ['{할일}, {마감}이야.', '{할일} 잊지 마. {마감}!'],
    done:    ['하나 끝!', '잘했어.', '좋아, 다음.'],
    idle:    ['나 여기 있어.', '잠깐 쉬어도 돼.'],
    morning: ['좋은 아침. 오늘 할 일 {개수}개야.', '왔구나. 오늘 할 일 {개수}개.'],
  };

  function defaultCharacter(name) {
    return {
      id: uid(), name: name || '포스트잇 꼬마', visible: true,
      mode: 'parts',
      parts: { head1: '', head2: '', body: '' },
      gifs: { idle: '', typing: '', done: '' },
      size: 160, depth: 6, hold: 110, flip: false, typeReact: true,
      sound: { mode: 'click', file: '', volume: 0.5 },     // click 기본 | file 내 소리 | off
      bubble: { shape: 'round', bg: '', fg: '', font: '', size: 16 }, // 빈 값 = 화면 밝기에 맞춤
      lines: clone(DEFAULT_LINES),
      urgentTalk: true, idleMin: 0, morning: true,
      pos: null,
    };
  }

  function defaultData() {
    const a = { id: uid(), name: '할 일', order: 0, kind: 'work', bg: { type: 'cork', color: '', image: '' } };
    const b = { id: uid(), name: '메모', order: 1, kind: 'life', bg: { type: 'cork', color: '', image: '' } };
    return {
      version: 2,
      state: { boards: [a, b], notes: [], current: a.id },
      settings: {
        characters: [defaultCharacter()],
        kinds: clone(DEFAULT_KINDS),
        keywords: clone(DEFAULT_KEYWORDS),
        urgentDays: 3,
        notePalette: DEFAULT_PALETTE.slice(),
        noteFont: 'Gaegu',
        hotkey: 'Ctrl+Alt+Space',
        theme: 'system',
        autoLaunch: false,
      },
    };
  }

  /* 빠진 칸 채우기 + 0.1 저장본 옮기기 */
  function normalizeChar(c) {
    const d = defaultCharacter(c && c.name);
    c = Object.assign(d, c || {});
    c.parts = Object.assign(defaultCharacter().parts, c.parts || {});
    c.gifs = Object.assign(defaultCharacter().gifs, c.gifs || {});
    if (typeof c.sound !== 'object' || c.sound === null) c.sound = { mode: c.sound === false ? 'off' : 'click', file: '', volume: 0.5 };
    c.sound = Object.assign({ mode: 'click', file: '', volume: 0.5 }, c.sound);
    c.bubble = Object.assign({ shape: 'round', bg: '', fg: '', font: '', size: 16 }, c.bubble || {});
    if (Array.isArray(c.lines)) c.lines = Object.assign(clone(DEFAULT_LINES), { click: c.lines });
    c.lines = Object.assign(clone(DEFAULT_LINES), c.lines || {});
    Object.keys(DEFAULT_LINES).forEach(k => { if (!Array.isArray(c.lines[k])) c.lines[k] = DEFAULT_LINES[k].slice(); });
    if (!c.id) c.id = uid();
    return c;
  }

  function normalize(d) {
    const def = defaultData();
    if (!d || typeof d !== 'object') return def;
    if (!d.state || !Array.isArray(d.state.boards) || !d.state.boards.length) d.state = def.state;
    d.state.notes = Array.isArray(d.state.notes) ? d.state.notes : [];
    const hadChars = !!(d.settings && Array.isArray(d.settings.characters) && d.settings.characters.length);
    const s = d.settings = Object.assign({}, def.settings, d.settings || {});
    // 0.1: character 하나 → characters 목록
    if (s.character && !hadChars) {
      const old = s.character;
      s.characters = [Object.assign(old, { pos: s.charPos || null, visible: s.charVisible !== false, name: '포스트잇 꼬마' })];
    }
    delete s.character; delete s.charPos; delete s.charVisible;
    if (!Array.isArray(s.characters) || !s.characters.length) s.characters = [defaultCharacter()];
    s.characters = s.characters.map(normalizeChar);
    if (!Array.isArray(s.kinds) || !s.kinds.length) s.kinds = clone(DEFAULT_KINDS);
    s.keywords = Object.assign(clone(DEFAULT_KEYWORDS), s.keywords || {});
    if (!Array.isArray(s.notePalette) || !s.notePalette.length) s.notePalette = DEFAULT_PALETTE.slice();
    s.urgentDays = clamp(+s.urgentDays || 3, 0, 14);
    if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = 'system';

    const kindIds = new Set(s.kinds.map(k => k.id));
    d.state.boards.forEach(b => {
      if (!kindIds.has(b.kind)) b.kind = s.kinds[Math.min(2, s.kinds.length - 1)].id;
      b.bg = Object.assign({ type: 'cork', color: '', image: '' }, b.bg || {});
    });
    if (!d.state.boards.find(b => b.id === d.state.current)) d.state.current = d.state.boards[0].id;
    d.state.notes.forEach(n => {
      n.pos = n.pos || {};
      n.blocks = Array.isArray(n.blocks) ? n.blocks : [];
      n.blocks.forEach(b => { if (!b.id) b.id = uid(); });
      if (!n.deco) n.deco = 'tape';
    });
    d.version = 2;
    return d;
  }

  /* ---------- 날짜 ---------- */
  function parseDue(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s);
    if (!m) return null;
    const t = m[4] !== undefined;
    return new Date(+m[1], +m[2] - 1, +m[3], t ? +m[4] : 23, t ? +m[5] : 59);
  }
  function hasTime(s) { return !!(s && s.length > 10); }
  function dayDiff(s, ref) {
    const d = parseDue(s); if (!d) return null;
    const t = ref ? new Date(ref) : new Date(); t.setHours(0, 0, 0, 0);
    const dd = new Date(d); dd.setHours(0, 0, 0, 0);
    return Math.round((dd - t) / 86400000);
  }
  function dueLabel(s, ref) {
    const d = dayDiff(s, ref); if (d === null) return '';
    let t = d < 0 ? `${-d}일 지남` : d === 0 ? '오늘' : d === 1 ? '내일' : `D-${d}`;
    if (hasTime(s)) t += ' ' + s.slice(11, 16);
    return t;
  }
  function remindTime(due, opt) {
    const d = parseDue(due); if (!d || !opt || opt === 'none') return null;
    const r = new Date(d);
    if (opt === '1h') r.setHours(r.getHours() - 1);
    else if (opt === '1d') r.setDate(r.getDate() - 1);
    else if (opt === '9am') r.setHours(9, 0, 0, 0);
    return r.toISOString();
  }
  function todayKey(ref) { const t = ref ? new Date(ref) : new Date(); return `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`; }

  /* ---------- 우선도 ---------- */
  function kindOf(settings, id) {
    const ks = (settings && settings.kinds) || DEFAULT_KINDS;
    return ks.find(k => k.id === id) || { id, label: '기타', w: 2 };
  }
  function weightOf(item, board, settings) {
    if (item.imp && IMP[item.imp]) return { w: IMP[item.imp].w, why: IMP[item.imp].label };
    const kind = kindOf(settings, board && board.kind);
    let w = +kind.w || 2, why = kind.label;
    const text = (item.text || '') + ' ' + (item.noteTitle || '');
    const k = (settings && settings.keywords) || DEFAULT_KEYWORDS;
    const hi = (k.high || []).find(x => x && text.includes(x));
    const lo = (k.low || []).find(x => x && text.includes(x));
    if (hi) { w += 1; why = hi; }
    if (lo) { w -= 1; why = lo; }
    return { w: clamp(w, 0.5, 5), why };
  }
  // 마감 N일 안: 날짜를 세게 / 그 전: 중요도 위주 / 마감 없음: 중요도만
  function scoreOf(item, w, ref, urgentDays) {
    const d = dayDiff(item.due, ref);
    const U = urgentDays == null ? 3 : urgentDays;
    if (d === null) return w * 10 - 25;
    if (d <= U) return 100 - d * 12 + w * 4;
    return w * 10 - Math.min(d, 60) * 0.4;
  }
  function collect(state, settings, ref) {
    const boards = {}; (state.boards || []).forEach(b => boards[b.id] = b);
    const U = settings && settings.urgentDays;
    const out = [];
    (state.notes || []).forEach(n => {
      const board = boards[n.boardId]; if (!board) return;
      (n.blocks || []).forEach(b => {
        if (b.type !== 'check' || b.done || !(b.text || '').trim()) return;
        const it = {
          id: b.id, noteId: n.id, boardId: n.boardId, text: b.text.trim(), due: b.due || null, imp: b.imp || 'auto',
          noteTitle: n.title || '', boardName: board.name, kind: board.kind,
        };
        const wo = weightOf(it, board, settings);
        it.weight = wo.w; it.why = wo.why;
        it.days = dayDiff(it.due, ref);
        it.score = scoreOf(it, wo.w, ref, U);
        out.push(it);
      });
    });
    return out.sort((a, b) => b.score - a.score || (a.text < b.text ? -1 : 1));
  }

  function findBlock(state, blockId) {
    for (const n of state.notes) for (const b of n.blocks) if (b.id === blockId) return { note: n, block: b };
    return null;
  }
  function addQuickItem(state, boardId, text, due, palette) {
    let n = state.notes.find(x => x.boardId === boardId && x.inbox);
    if (!n) {
      const z = state.notes.reduce((m, x) => Math.max(m, x.z || 0), 0) + 1;
      n = {
        id: uid(), boardId, inbox: true, title: '빠른 할 일', blocks: [], color: (palette && palette[0]) || DEFAULT_PALETTE[0],
        tilt: -1.5, deco: 'tape', z, pos: { pc: { x: 60, y: 60, w: 260, h: 200 } }, createdAt: now(), updatedAt: now(),
      };
      state.notes.push(n);
    }
    const b = { id: uid(), type: 'check', text, done: false };
    if (due) { b.due = due; b.remindOpt = '9am'; b.remindAt = remindTime(due, '9am'); }
    n.blocks.push(b); n.updatedAt = now();
    return b;
  }
  function setDone(state, blockId, done) {
    const f = findBlock(state, blockId); if (!f) return false;
    f.block.done = !!done; f.block.doneAt = done ? now() : null; f.note.updatedAt = now();
    return true;
  }
  function countDone(state) {
    let c = 0; (state.notes || []).forEach(n => (n.blocks || []).forEach(b => { if (b.type === 'check' && b.done) c++; }));
    return c;
  }
  // 대사 안의 {할일} {마감} {판} {개수} 채우기
  function fillLine(line, vars) {
    return String(line || '').replace(/\{(할일|마감|판|개수)\}/g, (_, k) => vars[k] != null ? vars[k] : '');
  }

  /* ---------- 저장 연결 ---------- */
  const LS_KEY = 'postit.data';
  const Store = {
    get hasApi() { return typeof window !== 'undefined' && !!window.api; },
    _local: null,
    async load() {
      if (this.hasApi) return normalize(await window.api.get());
      let d = null;
      try { d = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) {}
      if (!d) {
        try { const old = JSON.parse(localStorage.getItem('postit.v1')); if (old && old.boards) { d = defaultData(); d.state = old; } } catch (e) {}
      }
      this._local = normalize(d);
      return this._local;
    },
    save(patch) {
      if (this.hasApi) { window.api.set(patch); return; }
      this._local = Object.assign(this._local || defaultData(), patch);
      try { localStorage.setItem(LS_KEY, JSON.stringify(this._local)); } catch (e) {}
    },
    onChange(cb) {
      if (this.hasApi) { window.api.onChanged(d => cb(normalize(d))); return; }
      if (typeof window !== 'undefined') window.addEventListener('storage', e => {
        if (e.key === LS_KEY && e.newValue) { try { this._local = normalize(JSON.parse(e.newValue)); cb(this._local); } catch (_) {} }
      });
    },
  };

  return {
    uid, now, clamp, clone, DEFAULT_KINDS, LEVELS, IMP, DEFAULT_KEYWORDS, DEFAULT_PALETTE, DEFAULT_LINES,
    defaultCharacter, normalizeChar, defaultData, normalize, parseDue, hasTime, dayDiff, dueLabel, remindTime, todayKey,
    kindOf, weightOf, scoreOf, collect, findBlock, addQuickItem, setDone, countDone, fillLine, Store,
  };
});

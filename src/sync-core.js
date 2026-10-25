/* 동기화 계산 부분 — 컴퓨터 프로그램과 (나중에) 탭 앱이 같이 씀
   원칙: 판·포스트잇마다 rev(고친 시각, ms)를 붙이고, 더 큰 rev가 이김.
   지운 건 「묘비(tomb)」로 남겨서 다른 기기에서 다시 살아나지 않게 함 */
(function (root, factory) {
  const C = factory();
  if (typeof module === 'object' && module.exports) module.exports = C;
  else root.SyncCore = C;
})(typeof self !== 'undefined' ? self : this, function () {

  const SETTINGS_KEYS = ['kinds', 'keywords', 'urgentDays', 'notePalette', 'noteFont'];
  const TOMB_DAYS = 30;

  // 키 순서와 상관없이 같은지 비교 (서버 jsonb는 키 순서를 바꿈), rev는 빼고
  function strip(o) {
    const norm = v => {
      if (Array.isArray(v)) return v.map(norm);
      if (v && typeof v === 'object') {
        const out = {}; Object.keys(v).sort().forEach(k => { if (k !== 'rev' && v[k] !== undefined) out[k] = norm(v[k]); });
        return out;
      }
      return v;
    };
    return JSON.stringify(norm(o));
  }
  const byId = arr => new Map((arr || []).map(x => [x.id, x]));

  function emptyMeta() { return { pushed: {}, tomb: {}, settingsRev: 0, settingsPushed: 0, lastPull: 0 }; }
  function normMeta(m) {
    m = Object.assign(emptyMeta(), m || {});
    m.pushed = m.pushed || {}; m.tomb = m.tomb || {};
    return m;
  }

  function settingsSubset(s) {
    const o = {}; SETTINGS_KEYS.forEach(k => { if (s && s[k] !== undefined) o[k] = s[k]; });
    return o;
  }

  /* rev가 없는 오래된 것들에 처음 rev 붙이기 */
  function ensureRevs(state) {
    const fix = x => { if (!x.rev) x.rev = Date.parse(x.updatedAt || x.createdAt || '') || 1; };
    (state.boards || []).forEach(fix); (state.notes || []).forEach(fix);
  }

  /* 내 기기에서 바뀐 것 표시: 바뀐 건 rev를 지금으로, 사라진 건 묘비로 */
  function stamp(oldState, newState, meta, now) {
    now = now || Date.now();
    let changed = false;
    for (const [kind, key] of [['board', 'boards'], ['note', 'notes']]) {
      const oldMap = byId(oldState && oldState[key]);
      const newIds = new Set();
      (newState[key] || []).forEach(x => {
        newIds.add(x.id);
        const o = oldMap.get(x.id);
        if (!o || strip(o) !== strip(x)) { x.rev = Math.max(now, (o && o.rev || 0) + 1); changed = true; }
        else x.rev = o.rev || x.rev || 0;
        if (meta.tomb[x.id]) delete meta.tomb[x.id]; // 되돌리기로 살아난 것
      });
      oldMap.forEach((o, id) => {
        if (newIds.has(id)) return;
        meta.tomb[id] = { type: kind, rev: Math.max(now, (o.rev || 0) + 1), boardId: o.boardId || '', pushed: false };
        changed = true;
      });
    }
    return changed;
  }
  function stampSettings(oldS, newS, meta, now) {
    if (strip(settingsSubset(oldS)) === strip(settingsSubset(newS))) return false;
    meta.settingsRev = Math.max(now || Date.now(), (meta.settingsRev || 0) + 1);
    return true;
  }

  /* 올릴 것 모으기 */
  function collectPush(state, settings, meta) {
    const boards = [], notes = [];
    (state.boards || []).forEach(b => { if ((b.rev || 0) > (meta.pushed[b.id] ?? -1)) boards.push({ id: b.id, data: b, rev: b.rev || 0, deleted: false }); });
    (state.notes || []).forEach(n => { if ((n.rev || 0) > (meta.pushed[n.id] ?? -1)) notes.push({ id: n.id, board_id: n.boardId, data: n, rev: n.rev || 0, deleted: false }); });
    Object.entries(meta.tomb).forEach(([id, t]) => {
      if (t.pushed) return;
      const row = { id, data: {}, rev: t.rev, deleted: true };
      if (t.type === 'board') boards.push(row); else notes.push(Object.assign(row, { board_id: t.boardId || '' }));
    });
    const s = meta.settingsRev > (meta.settingsPushed || 0) ? { data: settingsSubset(settings), rev: meta.settingsRev } : null;
    return { boards, notes, settings: s, empty: !boards.length && !notes.length && !s };
  }
  function markPushed(meta, p) {
    [...p.boards, ...p.notes].forEach(r => {
      meta.pushed[r.id] = Math.max(meta.pushed[r.id] ?? -1, r.rev);
      if (r.deleted && meta.tomb[r.id] && meta.tomb[r.id].rev <= r.rev) meta.tomb[r.id].pushed = true;
    });
    if (p.settings) meta.settingsPushed = Math.max(meta.settingsPushed || 0, p.settings.rev);
  }

  /* 서버에서 받은 것 합치기 — 바뀐 게 있으면 true */
  function mergeRows(state, meta, key, rows) {
    let changed = false;
    const list = state[key];
    const kind = key === 'boards' ? 'board' : 'note';
    rows.forEach(r => {
      const rev = +r.rev || 0;
      const idx = list.findIndex(x => x.id === r.id);
      const local = idx >= 0 ? list[idx] : null;
      const tomb = meta.tomb[r.id];
      if (r.deleted) {
        if (local && (local.rev || 0) <= rev) { list.splice(idx, 1); changed = true; }
        if (!local || (local.rev || 0) <= rev) meta.tomb[r.id] = { type: kind, rev, boardId: r.board_id || '', pushed: true };
        meta.pushed[r.id] = Math.max(meta.pushed[r.id] ?? -1, rev);
        return;
      }
      const incoming = Object.assign({}, r.data, { id: r.id, rev });
      if (key === 'notes' && r.board_id) incoming.boardId = r.board_id;
      if (!local) {
        if (tomb && tomb.rev >= rev) return; // 여기서 지운 게 더 최근 → 곧 서버에도 지움
        delete meta.tomb[r.id];
        list.push(incoming); changed = true;
      } else if (rev > (local.rev || 0)) {
        list[idx] = incoming; changed = true;
      }
      if (rev >= ((list.find(x => x.id === r.id) || {}).rev || 0)) meta.pushed[r.id] = Math.max(meta.pushed[r.id] ?? -1, rev);
    });
    return changed;
  }
  function mergeRemote(state, settings, meta, remote) {
    let changed = false, settingsChanged = false;
    if (remote.boards && remote.boards.length) changed = mergeRows(state, meta, 'boards', remote.boards) || changed;
    if (remote.notes && remote.notes.length) changed = mergeRows(state, meta, 'notes', remote.notes) || changed;
    const rs = remote.settings;
    if (rs && (+rs.rev || 0) > (meta.settingsRev || 0) && rs.data) {
      SETTINGS_KEYS.forEach(k => { if (rs.data[k] !== undefined) settings[k] = rs.data[k]; });
      meta.settingsRev = meta.settingsPushed = +rs.rev; settingsChanged = true;
    }
    if (changed) {
      if (!state.boards.length) return { changed, settingsChanged, emptyBoards: true };
      if (!state.boards.find(b => b.id === state.current)) state.current = [...state.boards].sort((a, b) => a.order - b.order)[0].id;
    }
    return { changed, settingsChanged };
  }

  /* 오래된 묘비 정리 + 화면에 알려줄 지운 목록 */
  function prune(meta, now) {
    const limit = (now || Date.now()) - TOMB_DAYS * 86400e3;
    Object.entries(meta.tomb).forEach(([id, t]) => { if (t.pushed && t.rev < limit) delete meta.tomb[id]; });
  }
  function deletedIds(meta) { return Object.keys(meta.tomb); }

  return { SETTINGS_KEYS, emptyMeta, normMeta, settingsSubset, ensureRevs, stamp, stampSettings, collectPush, markPushed, mergeRemote, prune, deletedIds };
});

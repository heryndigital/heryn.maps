(() => {
'use strict';

/* =====================================================================
   Heryn Mapas — editor de mapas mentais
   Sem dependências. Os mapas ficam em localStorage (objeto Store); para
   sincronizar na nuvem basta trocar o Store por uma versão Firestore.
   ===================================================================== */

/* ---------- utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const PALETTE = ['#FDB933', '#4CC9F0', '#7BD88F', '#B388FF', '#FF6B8A', '#E8781E', '#5B8DEF', '#2DD4BF'];
const FONT_FAMILY = '"Hubot Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
// raiz, nível 1 e níveis mais profundos
const STYLES = [
  { size: 20, weight: 800, px: 24, py: 14, lh: 26, minW: 110, radius: 20 },
  { size: 15, weight: 700, px: 16, py: 9,  lh: 20, minW: 56,  radius: 13 },
  { size: 14, weight: 500, px: 13, py: 7,  lh: 19, minW: 44,  radius: 10 },
];
const MAX_NODE_W = 260;
const HGAP = 46, ROOT_GAP = 74, VGAP = 12;
const MAX_NODES = 5000;

/* ---------- armazenamento local ---------- */
const Store = {
  IDX: 'heryn-mapas:index',
  LAST: 'heryn-mapas:last',
  key: id => `heryn-mapas:map:${id}`,
  index() {
    try { return JSON.parse(localStorage.getItem(this.IDX)) || []; } catch { return []; }
  },
  load(id) {
    try { return JSON.parse(localStorage.getItem(this.key(id))); } catch { return null; }
  },
  save(m) {
    try {
      localStorage.setItem(this.key(m.id), JSON.stringify(m));
      const idx = this.index().filter(e => e.id !== m.id);
      idx.push({ id: m.id, title: m.title, updated: m.updated });
      idx.sort((a, b) => b.updated - a.updated);
      localStorage.setItem(this.IDX, JSON.stringify(idx));
      return true;
    } catch { return false; }
  },
  remove(id) {
    try {
      localStorage.removeItem(this.key(id));
      localStorage.setItem(this.IDX, JSON.stringify(this.index().filter(e => e.id !== id)));
    } catch { /* ignora */ }
  },
  getLast() { try { return localStorage.getItem(this.LAST); } catch { return null; } },
  setLast(id) { try { localStorage.setItem(this.LAST, id); } catch { /* ignora */ } },
};

/* ---------- modelo ---------- */
const newNode = (text = '') => ({ id: uid(), text, children: [], collapsed: false, color: null, side: null });

// Reconstrói a árvore garantindo campos válidos (usado ao carregar e importar).
function normalizeTree(root) {
  let count = 0;
  const seen = new Set();
  const walk = (n, depth, idx) => {
    if (!n || typeof n !== 'object' || depth > 60 || ++count > MAX_NODES) throw new Error('Arquivo de mapa inválido.');
    let id = typeof n.id === 'string' && n.id ? n.id.slice(0, 32) : uid();
    if (seen.has(id)) id = uid();
    seen.add(id);
    const out = {
      id,
      text: String(n.text ?? '').slice(0, 500),
      collapsed: depth > 0 && !!n.collapsed,
      color: /^#[0-9a-f]{3,8}$/i.test(n.color || '') ? n.color : null,
      side: n.side === 'l' ? 'l' : n.side === 'r' ? 'r' : null,
      children: [],
    };
    if (depth === 0) out.color = null;
    if (depth === 1) {
      out.side = out.side || (idx % 2 ? 'l' : 'r');
      out.color = out.color || PALETTE[idx % PALETTE.length];
    }
    const kids = Array.isArray(n.children) ? n.children : [];
    out.children = kids.map((c, i) => walk(c, depth + 1, i));
    return out;
  };
  return walk(root, 0, 0);
}

function sampleMap() {
  const mk = (text, kids = [], extra = {}) => ({ ...newNode(text), children: kids, ...extra });
  const root = mk('Meu primeiro mapa', [
    mk('Como usar', [
      mk('Tab cria um subtópico'), mk('Enter cria um tópico irmão'),
      mk('Duplo clique edita o texto'), mk('Espaço recolhe o ramo'),
    ], { side: 'r', color: PALETTE[0] }),
    mk('Organizar', [
      mk('Arraste um tópico para movê-lo'), mk('Solte na borda para reordenar'),
      mk('Troque as cores no menu de baixo'),
    ], { side: 'l', color: PALETTE[1] }),
    mk('Salvar e compartilhar', [
      mk('Salva sozinho neste navegador'), mk('Exporte em PNG, JSON ou Markdown'),
    ], { side: 'r', color: PALETTE[2] }),
    mk('Suas ideias', [mk('Estratégia'), mk('Conteúdo'), mk('Campanhas')], { side: 'l', color: PALETTE[3] }),
  ]);
  return { id: uid(), title: 'Meu primeiro mapa', updated: Date.now(), root };
}

/* ---------- estado ---------- */
let map = null;
let selId = null;
let editing = null;            // { id, isNew, before, orig }
let L = new Map();             // id -> layout
let clip = null;               // ramo copiado
const view = { x: 0, y: 0, k: 1 };
let autoFit = true;            // reenquadra enquanto o usuário não mexeu na vista
const undoS = [], redoS = [];
const els = new Map();

const stage = $('#stage'), world = $('#world'), elNodes = $('#nodes'), elLinks = $('#links');

/* ---------- busca na árvore ---------- */
function findNode(id, n = map.root, parent = null) {
  if (n.id === id) return { node: n, parent };
  for (const c of n.children) {
    const r = findNode(id, c, n);
    if (r) return r;
  }
  return null;
}
const contains = (a, b) => a === b || a.children.some(c => contains(c, b));
const countDesc = n => n.children.reduce((s, c) => s + 1 + countDesc(c), 0);

function cloneFresh(n) {
  return { ...n, id: uid(), children: n.children.map(cloneFresh) };
}

/* ---------- medição e layout ---------- */
const mctx = document.createElement('canvas').getContext('2d');

function wrapText(text, font, maxW) {
  mctx.font = font;
  const lines = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let cur = '';
    for (let w of words) {
      while (mctx.measureText(w).width > maxW && w.length > 1) {
        let i = w.length;
        while (i > 1 && mctx.measureText(w.slice(0, i)).width > maxW) i--;
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, i));
        w = w.slice(i);
      }
      if (!w) continue;
      const t = cur ? `${cur} ${w}` : w;
      if (cur && mctx.measureText(t).width > maxW) { lines.push(cur); cur = w; } else cur = t;
    }
    lines.push(cur);
  }
  return lines;
}

function layout() {
  L = new Map();
  const root = map.root;

  const build = (n, depth, dir, color) => {
    const st = STYLES[Math.min(depth, 2)];
    const font = `${st.weight} ${st.size}px ${FONT_FAMILY}`;
    const lines = wrapText(n.text, font, MAX_NODE_W - st.px * 2);
    mctx.font = font;
    const tw = Math.max(0, ...lines.map(l => mctx.measureText(l).width));
    const w = Math.ceil(Math.max(st.minW, tw + st.px * 2));
    const h = lines.length * st.lh + st.py * 2;
    const l = { n, depth, dir, color, lines, w, h, x: 0, y: 0, sh: h, st, font };
    L.set(n.id, l);
    if (!n.collapsed) {
      n.children.forEach((c, i) => {
        const cdir = depth === 0 ? (c.side === 'l' ? -1 : 1) : dir;
        const ccolor = depth === 0 ? (c.color || PALETTE[i % PALETTE.length]) : (c.color || color);
        build(c, depth + 1, cdir, ccolor);
      });
    }
    return l;
  };

  const kidsOf = n => (n.collapsed ? [] : n.children);
  const subH = n => {
    const l = L.get(n.id), kids = kidsOf(n);
    if (!kids.length) return (l.sh = l.h);
    const sum = kids.reduce((a, c) => a + subH(c), 0) + VGAP * (kids.length - 1);
    return (l.sh = Math.max(l.h, sum));
  };
  const place = (n, x, yc) => {
    const l = L.get(n.id), kids = kidsOf(n);
    l.x = x; l.y = yc - l.h / 2;
    if (!kids.length) return;
    const total = kids.reduce((a, c) => a + L.get(c.id).sh, 0) + VGAP * (kids.length - 1);
    let y = yc - total / 2;
    for (const c of kids) {
      const cl = L.get(c.id);
      const cx = l.dir > 0 ? l.x + l.w + HGAP : l.x - HGAP - cl.w;
      place(c, cx, y + cl.sh / 2);
      y += cl.sh + VGAP;
    }
  };

  const rl = build(root, 0, 1, null);
  rl.x = -rl.w / 2; rl.y = -rl.h / 2;
  for (const dir of [1, -1]) {
    const kids = root.children.filter(c => (c.side === 'l' ? -1 : 1) === dir);
    if (!kids.length) continue;
    kids.forEach(subH);
    const total = kids.reduce((a, c) => a + L.get(c.id).sh, 0) + VGAP * (kids.length - 1);
    let y = -total / 2;
    for (const c of kids) {
      const cl = L.get(c.id);
      const cx = dir > 0 ? rl.x + rl.w + ROOT_GAP : rl.x - ROOT_GAP - cl.w;
      place(c, cx, y + cl.sh / 2);
      y += cl.sh + VGAP;
    }
  }
}

function bounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of L.values()) {
    x0 = Math.min(x0, l.x); y0 = Math.min(y0, l.y);
    x1 = Math.max(x1, l.x + l.w); y1 = Math.max(y1, l.y + l.h);
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function linkGeom(pl, cl) {
  const x1 = cl.dir > 0 ? pl.x + pl.w : pl.x;
  const x2 = cl.dir > 0 ? cl.x : cl.x + cl.w;
  const y1 = pl.y + pl.h / 2, y2 = cl.y + cl.h / 2;
  return { x1, y1, x2, y2, xm: (x1 + x2) / 2 };
}
const linkWidth = depth => (depth <= 1 ? 4.5 : depth === 2 ? 3 : 2.2);

function onColor(hex) {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6);
  const r = parseInt(f.slice(0, 2), 16), g = parseInt(f.slice(2, 4), 16), b = parseInt(f.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.58 ? '#0a0a0a' : '#ffffff';
}

/* ---------- renderização ---------- */
function makeNodeEl(l) {
  const el = document.createElement('div');
  el.className = `node lvl${Math.min(l.depth, 2)}`;
  el.dataset.id = l.n.id;
  el.style.font = `${l.st.weight} ${l.st.size}px/${l.st.lh}px ${FONT_FAMILY}`;
  el.style.padding = `${l.st.py}px ${l.st.px}px`;
  el.style.borderRadius = `${l.st.radius}px`;
  el.innerHTML = '<span class="t"></span><button class="tog" tabindex="-1" aria-label="Recolher ou expandir"></button>' +
    '<button class="add" tabindex="-1" aria-label="Novo subtópico"><svg><use href="#i-plus"/></svg></button>';
  return el;
}

function geometry() {
  const parts = [];
  for (const l of L.values()) {
    const el = els.get(l.n.id);
    if (!el) continue;
    const n = l.n;
    el.style.left = `${l.x}px`; el.style.top = `${l.y}px`;
    el.style.width = `${l.w}px`; el.style.height = `${l.h}px`;
    el.classList.toggle('r', l.dir > 0);
    el.classList.toggle('l', l.dir < 0);
    el.classList.toggle('has-kids', n.children.length > 0);
    el.classList.toggle('folded', n.collapsed && n.children.length > 0);
    if (l.color) { el.style.setProperty('--c', l.color); el.style.setProperty('--on', onColor(l.color)); }
    if (!editing || editing.id !== n.id) $('.t', el).textContent = l.lines.join('\n');
    const tog = $('.tog', el);
    if (n.children.length) {
      const key = n.collapsed ? `n${countDesc(n)}` : 'minus';
      if (tog.dataset.k !== key) {
        tog.dataset.k = key;
        if (n.collapsed) tog.textContent = countDesc(n);
        else tog.innerHTML = '<svg><use href="#i-minus"/></svg>';
      }
    }
    if (!n.collapsed) {
      for (const c of n.children) {
        const cl = L.get(c.id);
        if (!cl) continue;
        const g = linkGeom(l, cl);
        parts.push(`<path d="M${g.x1} ${g.y1}C${g.xm} ${g.y1} ${g.xm} ${g.y2} ${g.x2} ${g.y2}" stroke="${cl.color}" stroke-width="${linkWidth(cl.depth)}"/>`);
      }
    }
  }
  elLinks.innerHTML = parts.join('');
}

function render() {
  layout();
  elNodes.textContent = '';
  els.clear();
  const frag = document.createDocumentFragment();
  for (const l of L.values()) {
    const el = makeNodeEl(l);
    els.set(l.n.id, el);
    frag.appendChild(el);
  }
  elNodes.appendChild(frag);
  geometry();
  syncSel();
  updateUI();
}

function syncSel() {
  for (const [id, el] of els) el.classList.toggle('sel', id === selId);
  updateDock();
}

function select(id) {
  selId = id;
  syncSel();
}

/* ---------- vista (pan / zoom) ---------- */
function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  const s = 24 * view.k;
  stage.style.backgroundSize = `${s}px ${s}px`;
  stage.style.backgroundPosition = `${view.x}px ${view.y}px`;
  $('#zoomLabel').textContent = `${Math.round(view.k * 100)}%`;
}
let animTimer = 0;
function animate() {
  world.classList.add('anim');
  clearTimeout(animTimer);
  animTimer = setTimeout(() => world.classList.remove('anim'), 320);
}
function zoomAt(px, py, k) {
  autoFit = false;
  k = clamp(k, 0.2, 3);
  view.x = px - (px - view.x) * (k / view.k);
  view.y = py - (py - view.y) * (k / view.k);
  view.k = k;
  applyView();
}
function fit(animated = true, maxK = 1) {
  const W = stage.clientWidth, H = stage.clientHeight;
  const b = bounds();
  const padX = 80, padTop = 60, padBottom = 110;
  const k = clamp(Math.min((W - padX * 2) / b.w, (H - padTop - padBottom) / b.h, maxK), 0.2, 3);
  if (animated) animate();
  autoFit = true;
  view.k = k;
  view.x = W / 2 - (b.x0 + b.w / 2) * k;
  view.y = padTop + (H - padTop - padBottom) / 2 - (b.y0 + b.h / 2) * k;
  applyView();
}
function ensureVisible(id) {
  const l = L.get(id);
  if (!l) return;
  const W = stage.clientWidth, H = stage.clientHeight, mx = 80, top = 70, bottom = 120;
  const left = view.x + l.x * view.k, right = view.x + (l.x + l.w) * view.k;
  const t = view.y + l.y * view.k, b = view.y + (l.y + l.h) * view.k;
  let dx = 0, dy = 0;
  if (left < mx) dx = mx - left; else if (right > W - mx) dx = W - mx - right;
  if (t < top) dy = top - t; else if (b > H - bottom) dy = H - bottom - b;
  if (dx || dy) { animate(); view.x += dx; view.y += dy; applyView(); }
}

/* ---------- histórico e salvamento ---------- */
function pushUndoStr(s) {
  undoS.push(s);
  if (undoS.length > 150) undoS.shift();
  redoS.length = 0;
}
const pushUndo = () => pushUndoStr(JSON.stringify(map.root));

function undo() {
  finishEdit(true);
  if (!undoS.length) return;
  redoS.push(JSON.stringify(map.root));
  map.root = JSON.parse(undoS.pop());
  afterHistory();
}
function redo() {
  finishEdit(true);
  if (!redoS.length) return;
  undoS.push(JSON.stringify(map.root));
  map.root = JSON.parse(redoS.pop());
  afterHistory();
}
function afterHistory() {
  if (!findNode(selId)) selId = map.root.id;
  changed();
  ensureVisible(selId);
}

let saveTimer = 0;
function scheduleSave() {
  $('#saveState').textContent = 'Salvando…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
function flushSave() {
  if (!map) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  map.updated = Date.now();
  const ok = Store.save(map);
  $('#saveState').textContent = ok ? 'Salvo neste navegador' : 'Erro ao salvar';
  if (!ok) toast('Não foi possível salvar: armazenamento do navegador cheio ou bloqueado.');
  renderDrawer();
}

function changed() {
  render();
  scheduleSave();
}
function mutate(fn) {
  finishEdit(true);
  pushUndo();
  fn();
  changed();
}

/* ---------- edição de tópicos ---------- */
function pickSide() {
  const r = map.root.children.filter(c => c.side !== 'l').length;
  return r <= map.root.children.length - r ? 'r' : 'l';
}
function pickColor() {
  const used = new Set(map.root.children.map(c => c.color));
  return PALETTE.find(c => !used.has(c)) || PALETTE[map.root.children.length % PALETTE.length];
}

function addChild(pid = selId) {
  finishEdit(true);
  const f = findNode(pid);
  if (!f) return;
  const p = f.node, n = newNode('');
  pushUndo();
  p.collapsed = false;
  if (p === map.root) { n.side = pickSide(); n.color = pickColor(); }
  p.children.push(n);
  selId = n.id;
  changed();
  ensureVisible(n.id);
  startEdit(n.id, true);
}

function addSibling(id = selId) {
  finishEdit(true);
  const f = findNode(id);
  if (!f) return;
  if (!f.parent) return addChild(id);
  const n = newNode('');
  pushUndo();
  if (f.parent === map.root) { n.side = f.node.side; n.color = pickColor(); }
  f.parent.children.splice(f.parent.children.indexOf(f.node) + 1, 0, n);
  selId = n.id;
  changed();
  ensureVisible(n.id);
  startEdit(n.id, true);
}

function deleteNode(id = selId) {
  const f = findNode(id);
  if (!f || !f.parent) return;
  const sibs = f.parent.children, i = sibs.indexOf(f.node);
  mutate(() => {
    sibs.splice(i, 1);
    selId = (sibs[i] || sibs[i - 1] || f.parent).id;
  });
}

function duplicateNode(id = selId) {
  const f = findNode(id);
  if (!f || !f.parent) return;
  mutate(() => {
    const c = cloneFresh(f.node);
    if (f.parent === map.root) c.color = pickColor();
    f.parent.children.splice(f.parent.children.indexOf(f.node) + 1, 0, c);
    selId = c.id;
  });
}

function toggleFold(id = selId) {
  const f = findNode(id);
  if (!f || !f.parent || !f.node.children.length) return;
  mutate(() => {
    f.node.collapsed = !f.node.collapsed;
    if (f.node.collapsed) selId = f.node.id;   // a seleção não pode ficar escondida
  });
}

function setColor(color) {
  const f = findNode(selId);
  if (!f || !f.parent) return;
  mutate(() => { f.node.color = color; });
}

function copyNode(cut = false) {
  const f = findNode(selId);
  if (!f) return;
  clip = JSON.stringify(f.node);
  toast(cut ? 'Ramo recortado' : 'Ramo copiado');
  if (cut && f.parent) deleteNode(selId);
}
function pasteNode() {
  if (!clip) return;
  const f = findNode(selId);
  if (!f) return;
  mutate(() => {
    const c = cloneFresh(JSON.parse(clip));
    if (f.node === map.root) { c.side = pickSide(); c.color = pickColor(); } else c.color = null;
    f.node.collapsed = false;
    f.node.children.push(c);
    selId = c.id;
  });
  ensureVisible(selId);
}

function moveNode(id, targetId, mode) {
  const src = findNode(id), tgt = findNode(targetId);
  if (!src || !tgt || !src.parent || id === targetId || contains(src.node, tgt.node)) return;
  if (tgt.node === map.root) mode = 'child';
  finishEdit(true);
  pushUndo();
  const wasRootKid = src.parent === map.root;
  src.parent.children.splice(src.parent.children.indexOf(src.node), 1);
  let parent, idx;
  if (mode === 'child') {
    parent = tgt.node;
    parent.collapsed = false;
    idx = parent.children.length;
  } else {
    parent = tgt.parent;
    idx = parent.children.indexOf(tgt.node) + (mode === 'after' ? 1 : 0);
  }
  if (parent === map.root) {
    src.node.side = mode === 'child' ? pickSide() : tgt.node.side;
    if (!wasRootKid) src.node.color = pickColor();
  } else if (wasRootKid) {
    src.node.color = null;
  }
  parent.children.splice(idx, 0, src.node);
  selId = id;
  changed();
}

/* editor de texto in-place */
function startEdit(id, isNew = false) {
  finishEdit(true);
  const l = L.get(id), el = els.get(id);
  if (!l || !el) return;
  editing = { id, isNew, before: JSON.stringify(map.root), orig: l.n.text };
  el.classList.add('editing');
  const t = $('.t', el);
  t.textContent = l.n.text;
  t.contentEditable = 'true';
  t.focus();
  const range = document.createRange();
  range.selectNodeContents(t);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(range);
}

function finishEdit(commit = true) {
  if (!editing) return;
  const { id, isNew, before, orig } = editing;
  editing = null;
  const f = findNode(id);
  if (!f) { render(); return; }
  const n = f.node;
  const text = n.text.replace(/ /g, ' ').trim();
  const drop = isNew && (!commit || !text);
  if (drop) {
    if (f.parent) f.parent.children.splice(f.parent.children.indexOf(n), 1);
    undoS.pop();                       // descarta o passo criado junto com o tópico
    selId = (f.parent || n).id;
  } else if (!commit || !text) {
    n.text = orig;
  } else {
    n.text = text;
    if (!isNew && text !== orig) pushUndoStr(before);
  }
  changed();
}

/* ---------- navegação por teclado ---------- */
function navigate(key) {
  const l = L.get(selId);
  if (!l) return;
  const n = l.n;
  let target = null;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const want = key === 'ArrowRight' ? 1 : -1;
    if (l.depth === 0) {
      const k = n.children.find(c => (c.side === 'l' ? -1 : 1) === want);
      if (k) target = k.id;
    } else if (l.dir === want) {
      if (!n.children.length) return;
      if (n.collapsed) { toggleFold(n.id); return; }
      target = n.children[0].id;
    } else {
      target = findNode(n.id).parent.id;
    }
  } else if (l.depth > 0) {
    const cy = l.y + l.h / 2;
    let best = null, bestScore = Infinity;
    for (const o of L.values()) {
      if (o === l || o.depth !== l.depth || o.dir !== l.dir) continue;
      const oy = o.y + o.h / 2, dy = key === 'ArrowUp' ? cy - oy : oy - cy;
      if (dy <= 1) continue;
      const score = dy + Math.abs(o.x - l.x) * 2;
      if (score < bestScore) { best = o; bestScore = score; }
    }
    if (best) target = best.n.id;
  }
  if (target) { select(target); ensureVisible(target); }
}

/* ---------- interface: dock, barra, gaveta ---------- */
const swatches = $('#swatches');
PALETTE.forEach(c => {
  const b = document.createElement('button');
  b.className = 'sw';
  b.style.setProperty('--c', c);
  b.dataset.color = c;
  b.title = 'Cor do ramo';
  b.setAttribute('aria-label', `Cor ${c}`);
  swatches.appendChild(b);
});

function updateDock() {
  const f = selId && map ? findNode(selId) : null;
  const isRoot = !!f && !f.parent;
  $('#dChild').disabled = !f;
  $('#dSibling').disabled = !f;
  $('#dFold').disabled = !f || isRoot || !f.node.children.length;
  $('#dDup').disabled = !f || isRoot;
  $('#dDel').disabled = !f || isRoot;
  const cur = f && L.get(f.node.id) ? L.get(f.node.id).color : null;
  for (const b of swatches.children) {
    b.disabled = !f || isRoot;
    b.classList.toggle('on', !!cur && b.dataset.color.toLowerCase() === cur.toLowerCase());
  }
}
function updateUI() {
  $('#btnUndo').disabled = !undoS.length;
  $('#btnRedo').disabled = !redoS.length;
  $('#hint').hidden = !(map && map.root.children.length === 0);
  updateDock();
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function setDrawer(open) {
  document.body.classList.toggle('drawer-open', open);
  $('#scrim').hidden = !open;
  if (open) renderDrawer();
}

function renderDrawer() {
  const ul = $('#mapList');
  ul.textContent = '';
  const fmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  for (const e of Store.index()) {
    const li = document.createElement('li');
    li.className = e.id === map?.id ? 'active' : '';
    li.innerHTML = '<button class="open"><b></b><small></small></button>' +
      '<button class="ico dup" title="Duplicar mapa" aria-label="Duplicar mapa"><svg><use href="#i-copy"/></svg></button>' +
      '<button class="ico del" title="Excluir mapa" aria-label="Excluir mapa"><svg><use href="#i-trash"/></svg></button>';
    $('b', li).textContent = e.title || 'Sem título';
    $('small', li).textContent = fmt.format(e.updated);
    $('.open', li).onclick = () => { openMap(e.id); setDrawer(false); };
    $('.dup', li).onclick = () => duplicateMap(e.id);
    $('.del', li).onclick = () => deleteMap(e.id);
    ul.appendChild(li);
  }
}

/* ---------- gestão de mapas ---------- */
function openMap(id) {
  finishEdit(true);
  if (map) flushSave();
  let m = Store.load(id);
  try { if (m) m.root = normalizeTree(m.root); } catch { m = null; }
  if (!m) { m = sampleMap(); Store.save(m); }
  map = m;
  undoS.length = 0; redoS.length = 0;
  selId = map.root.id;
  $('#title').value = map.title;
  Store.setLast(map.id);
  render();
  fit(false);
  renderDrawer();
  $('#saveState').textContent = 'Salvo neste navegador';
}

function createMap() {
  flushSave();
  const m = { id: uid(), title: 'Novo mapa', updated: Date.now(), root: newNode('Tema central') };
  Store.save(m);
  openMap(m.id);
  setDrawer(false);
  startEdit(m.root.id);
}

function duplicateMap(id) {
  if (map && id === map.id) flushSave();
  const src = Store.load(id);
  if (!src) return;
  const m = { ...src, id: uid(), title: `${src.title} (cópia)`, updated: Date.now() };
  Store.save(m);
  renderDrawer();
  toast('Mapa duplicado');
}

function deleteMap(id) {
  const e = Store.index().find(x => x.id === id);
  if (!confirm(`Excluir o mapa "${e ? e.title : ''}"? Esta ação não pode ser desfeita.`)) return;
  const current = map && id === map.id;
  if (current) { clearTimeout(saveTimer); saveTimer = 0; }
  Store.remove(id);
  if (current) {
    map = null;
    const next = Store.index()[0];
    openMap(next ? next.id : '');
  }
  renderDrawer();
}

/* ---------- exportar / importar ---------- */
const slug = s => (s || 'mapa').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'mapa';
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function exportJSON() {
  flushSave();
  const data = { app: 'heryn-mapas', version: 1, title: map.title, root: map.root };
  download(`${slug(map.title)}.json`, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
}

function exportMarkdown() {
  const one = s => s.replace(/\s*\n\s*/g, ' ');
  const out = [`# ${one(map.root.text) || map.title}`, ''];
  const walk = (n, d) => n.children.forEach(c => { out.push(`${'  '.repeat(d)}- ${one(c.text)}`); walk(c, d + 1); });
  walk(map.root, 0);
  download(`${slug(map.title)}.md`, new Blob([out.join('\n') + '\n'], { type: 'text/markdown' }));
}

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function exportPNG() {
  finishEdit(true);
  const cs = getComputedStyle(document.documentElement);
  const css = n => cs.getPropertyValue(n).trim();
  const pad = 60, b = bounds();
  const W = b.w + pad * 2, H = b.h + pad * 2;
  let scale = 2;
  while (scale > 0.25 && (W * scale > 8000 || H * scale > 8000 || W * H * scale * scale > 40e6)) scale -= 0.25;
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
  const ctx = cv.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(pad - b.x0, pad - b.y0);
  ctx.fillStyle = css('--bg');
  ctx.fillRect(b.x0 - pad, b.y0 - pad, W, H);

  ctx.lineCap = 'round';
  for (const l of L.values()) {
    if (l.n.collapsed) continue;
    for (const c of l.n.children) {
      const cl = L.get(c.id);
      if (!cl) continue;
      const g = linkGeom(l, cl);
      ctx.strokeStyle = cl.color;
      ctx.lineWidth = linkWidth(cl.depth);
      ctx.beginPath();
      ctx.moveTo(g.x1, g.y1);
      ctx.bezierCurveTo(g.xm, g.y1, g.xm, g.y2, g.x2, g.y2);
      ctx.stroke();
    }
  }
  for (const l of L.values()) {
    const st = l.st;
    let text;
    if (l.depth === 0) {
      const g = ctx.createLinearGradient(l.x, l.y, l.x + l.w, l.y + l.h);
      g.addColorStop(0, '#E8781E'); g.addColorStop(1, '#FDB933');
      ctx.fillStyle = g; rr(ctx, l.x, l.y, l.w, l.h, st.radius); ctx.fill();
      text = '#0a0a0a';
    } else if (l.depth === 1) {
      ctx.fillStyle = l.color; rr(ctx, l.x, l.y, l.w, l.h, st.radius); ctx.fill();
      text = onColor(l.color);
    } else {
      ctx.fillStyle = css('--surface'); rr(ctx, l.x, l.y, l.w, l.h, st.radius); ctx.fill();
      ctx.strokeStyle = l.color; ctx.lineWidth = 2;
      rr(ctx, l.x + 1, l.y + 1, l.w - 2, l.h - 2, st.radius - 1); ctx.stroke();
      text = css('--text');
    }
    if (l.n.collapsed && l.n.children.length) {
      const cx = l.dir > 0 ? l.x + l.w + 16 : l.x - 16, cy = l.y + l.h / 2;
      ctx.fillStyle = l.color || '#FDB933';
      ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = onColor(l.color || '#FDB933');
      ctx.font = `700 11px ${FONT_FAMILY}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(countDesc(l.n)), cx, cy + 0.5);
    }
    ctx.fillStyle = text;
    ctx.font = l.font;
    ctx.textBaseline = 'middle';
    const centered = l.depth <= 1;
    ctx.textAlign = centered ? 'center' : 'left';
    l.lines.forEach((ln, i) => {
      ctx.fillText(ln, centered ? l.x + l.w / 2 : l.x + st.px, l.y + st.py + (i + 0.5) * st.lh);
    });
  }
  cv.toBlob(blob => blob ? download(`${slug(map.title)}.png`, blob) : toast('Não foi possível gerar a imagem.'), 'image/png');
}

function importFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      if (String(reader.result).length > 8e6) throw new Error('Arquivo grande demais.');
      const data = JSON.parse(reader.result);
      const root = normalizeTree(data.root || data);
      const title = String(data.title || root.text || 'Mapa importado').slice(0, 80);
      flushSave();
      const m = { id: uid(), title, updated: Date.now(), root };
      if (!Store.save(m)) throw new Error('Armazenamento cheio.');
      openMap(m.id);
      toast('Mapa importado');
    } catch (err) {
      toast(`Falha ao importar: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

/* ---------- eventos: barra e menus ---------- */
$('#btnDrawer').onclick = () => setDrawer(!document.body.classList.contains('drawer-open'));
$('#btnDrawerClose').onclick = $('#scrim').onclick = () => setDrawer(false);
$('#btnNewMap').onclick = createMap;
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#btnFit').onclick = () => fit(true);
$('#btnZoomIn').onclick = () => { animate(); zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, view.k * 1.2); };
$('#btnZoomOut').onclick = () => { animate(); zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, view.k / 1.2); };
$('#zoomLabel').onclick = () => { animate(); zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1); };
$('#btnHelp').onclick = () => { $('#help').hidden = false; };
$('#btnHelpClose').onclick = () => { $('#help').hidden = true; };
$('#help').addEventListener('pointerdown', e => { if (e.target.id === 'help') $('#help').hidden = true; });

const menu = $('#menuExport');
$('#btnExport').onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
document.addEventListener('pointerdown', e => { if (!e.target.closest('.menuwrap')) menu.hidden = true; });
menu.addEventListener('click', e => {
  const act = e.target.closest('button')?.dataset.export;
  if (!act) return;
  menu.hidden = true;
  if (act === 'png') exportPNG();
  else if (act === 'json') exportJSON();
  else if (act === 'md') exportMarkdown();
  else if (act === 'import') $('#fileImport').click();
});
$('#fileImport').onchange = e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importFile(f);
};

const title = $('#title');
title.addEventListener('input', () => {
  if (!map) return;
  map.title = title.value.trim() || 'Sem título';
  scheduleSave();
});
title.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') title.blur(); });

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#btnTheme').innerHTML = `<svg><use href="#i-${t === 'dark' ? 'moon' : 'sun'}"/></svg>`;
  try { localStorage.setItem('heryn-mapas:theme', t); } catch { /* ignora */ }
}
$('#btnTheme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

/* dock */
$('#dock').addEventListener('mousedown', e => e.preventDefault());   // não rouba o foco do editor
$('#dChild').onclick = () => addChild();
$('#dSibling').onclick = () => addSibling();
$('#dFold').onclick = () => toggleFold();
$('#dDup').onclick = () => duplicateNode();
$('#dDel').onclick = () => deleteNode();
swatches.addEventListener('click', e => {
  const c = e.target.closest('.sw')?.dataset.color;
  if (c) setColor(c);
});

/* ---------- eventos: canvas ---------- */
elNodes.addEventListener('click', e => {
  const btn = e.target.closest('button');
  const el = e.target.closest('.node');
  if (!btn || !el) return;
  if (btn.classList.contains('add')) addChild(el.dataset.id);
  else if (btn.classList.contains('tog')) toggleFold(el.dataset.id);
});
elNodes.addEventListener('dblclick', e => {
  const el = e.target.closest('.node');
  if (el && !e.target.closest('button')) startEdit(el.dataset.id);
});
elNodes.addEventListener('input', e => {
  if (!editing || !e.target.classList.contains('t')) return;
  const f = findNode(editing.id);
  if (!f) return;
  f.node.text = e.target.innerText.replace(/ /g, ' ');
  layout();
  geometry();
});
elNodes.addEventListener('keydown', e => {
  if (!editing || !e.target.classList.contains('t')) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit(true); }
  else if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
  else if (e.key === 'Tab') { e.preventDefault(); const id = editing.id; finishEdit(true); if (findNode(id)) addChild(id); }
  e.stopPropagation();
});
elNodes.addEventListener('paste', e => {
  if (!editing) return;
  e.preventDefault();
  document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
});
elNodes.addEventListener('focusout', e => {
  if (editing && e.target.classList.contains('t')) finishEdit(true);
});

stage.addEventListener('wheel', e => {
  e.preventDefault();
  world.classList.remove('anim');
  const r = stage.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, view.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
}, { passive: false });

let drag = null, ghost = null, dropEl = null;
const ptrs = new Map();
let pinch = null;

function clearDrop() {
  if (dropEl) dropEl.classList.remove('drop-child', 'drop-before', 'drop-after');
  dropEl = null;
}
function endDrag(apply) {
  if (drag && drag.type === 'node' && drag.started) {
    els.get(drag.id)?.classList.remove('dragging');
    ghost?.remove();
    ghost = null;
    const t = drag.target;
    clearDrop();
    if (apply && t) moveNode(drag.id, t.id, t.mode);
  }
  stage.classList.remove('panning');
  drag = null;
}

stage.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('button')) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) {
    endDrag(false);
    const [a, b] = [...ptrs.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
    return;
  }
  if (editing && e.target.closest('.t')) return;
  world.classList.remove('anim');
  const nodeEl = e.target.closest('.node');
  if (nodeEl) {
    const id = nodeEl.dataset.id;
    select(id);
    if (id !== map.root.id) drag = { type: 'node', id, sx: e.clientX, sy: e.clientY, started: false, target: null };
    else drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  } else {
    finishEdit(true);
    drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    stage.classList.add('panning');
  }
});

window.addEventListener('pointermove', e => {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    const r = stage.getBoundingClientRect();
    zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d);
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (drag.type === 'pan') {
    autoFit = false;
    view.x = drag.vx + dx; view.y = drag.vy + dy;
    applyView();
    return;
  }
  if (!drag.started && Math.hypot(dx, dy) > 6) {
    drag.started = true;
    finishEdit(true);
    const src = els.get(drag.id);
    if (!src) { drag = null; return; }
    ghost = src.cloneNode(true);
    ghost.className = `${src.className.replace(/\b(sel|r|l)\b/g, '')} ghost`;
    ghost.style.transform = '';
    document.body.appendChild(ghost);
    src.classList.add('dragging');
  }
  if (!drag.started) return;
  ghost.style.left = `${e.clientX + 14}px`;
  ghost.style.top = `${e.clientY + 14}px`;
  ghost.style.transform = `scale(${view.k})`;
  clearDrop();
  drag.target = null;
  const hit = document.elementsFromPoint(e.clientX, e.clientY).find(x => x.classList?.contains('node') && x !== ghost);
  if (!hit || hit.dataset.id === drag.id) return;
  const src = findNode(drag.id), tgt = findNode(hit.dataset.id);
  if (!src || !tgt || contains(src.node, tgt.node)) return;
  const r = hit.getBoundingClientRect(), fy = (e.clientY - r.top) / r.height;
  const mode = !tgt.parent ? 'child' : fy < 0.28 ? 'before' : fy > 0.72 ? 'after' : 'child';
  hit.classList.add(`drop-${mode}`);
  dropEl = hit;
  drag.target = { id: tgt.node.id, mode };
});

const release = e => {
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (drag && ptrs.size === 0) endDrag(e.type === 'pointerup');
};
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);

/* ---------- eventos: teclado ---------- */
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('#help').hidden) { $('#help').hidden = true; return; }
    if (document.body.classList.contains('drawer-open')) { setDrawer(false); return; }
    menu.hidden = true;
  }
  const t = e.target;
  if (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
  if (t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
  if (!map) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    switch (e.key.toLowerCase()) {
      case 'z': e.preventDefault(); e.shiftKey ? redo() : undo(); break;
      case 'y': e.preventDefault(); redo(); break;
      case 'd': e.preventDefault(); duplicateNode(); break;
      case 'c': e.preventDefault(); copyNode(false); break;
      case 'x': e.preventDefault(); copyNode(true); break;
      case 'v': e.preventDefault(); pasteNode(); break;
      case 's': e.preventDefault(); flushSave(); toast('Mapa salvo'); break;
      case '0': e.preventDefault(); fit(true); break;
      case '=': case '+': e.preventDefault(); animate(); zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, view.k * 1.2); break;
      case '-': e.preventDefault(); animate(); zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, view.k / 1.2); break;
    }
    return;
  }
  switch (e.key) {
    case 'Tab': e.preventDefault(); addChild(); break;
    case 'Enter': e.preventDefault(); addSibling(); break;
    case 'Insert': e.preventDefault(); addChild(); break;
    case 'F2': e.preventDefault(); if (selId) startEdit(selId); break;
    case ' ': e.preventDefault(); toggleFold(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); deleteNode(); break;
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': e.preventDefault(); navigate(e.key); break;
    case '?': $('#help').hidden = false; break;
  }
});

window.addEventListener('pagehide', () => { finishEdit(true); flushSave(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && map) flushSave(); });
new ResizeObserver(() => { if (!map) return; if (autoFit) fit(false); else applyView(); }).observe(stage);

/* ---------- início ---------- */
async function init() {
  let theme = 'dark';
  try { theme = localStorage.getItem('heryn-mapas:theme') || 'dark'; } catch { /* ignora */ }
  applyTheme(theme);
  try {
    await Promise.all([
      document.fonts.load(`800 20px ${FONT_FAMILY}`),
      document.fonts.load(`700 15px ${FONT_FAMILY}`),
      document.fonts.load(`500 14px ${FONT_FAMILY}`),
    ]);
  } catch { /* segue com a fonte de reserva */ }
  const idx = Store.index();
  const last = Store.getLast();
  const first = idx.find(e => e.id === last) || idx[0];
  if (first) openMap(first.id);
  else { const m = sampleMap(); Store.save(m); openMap(m.id); }
}
init();

})();

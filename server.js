// Typing Pro - máy chủ: ghép cặp, giữ đồng hồ, chấm điểm (server-authoritative)
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
// Giám thị 1 (admin, toàn quyền): ADMIN_PASS. Giám thị 2 (chỉ quản lý thi theo lớp): PROCTOR_PASS (không đặt = tắt vai trò này).
const PROCTOR_PASS = process.env.PROCTOR_PASS || '';
// ---- Lưu trữ: Upstash Redis (vĩnh viễn) nếu có biến môi trường, nếu không thì lưu file (mất khi Render khởi động lại) ----
const UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN, DB = !!(UP_URL && UP_TOKEN);
async function redis(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status)); return j.result;
}
async function kvGet(k) {
  if (DB) { const v = await redis(['GET', 'tp:' + k]); return v ? JSON.parse(v) : null; }
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, k + '.json'), 'utf8')); } catch (e) { return null; }
}
async function kvSet(k, v) {
  if (DB) return redis(['SET', 'tp:' + k, JSON.stringify(v)]);
  fs.writeFileSync(path.join(__dirname, k + '.json'), JSON.stringify(v));
}
const dirty = new Set(); let flushTimer = null;
const valOf = k => ({ config: cfg, students: ST, lb: LB, history, sessions: CS }[k]);
function save(...keys) { keys.forEach(k => dirty.add(k)); if (!flushTimer) flushTimer = setTimeout(flush, 1500); }
async function flush() {
  clearTimeout(flushTimer); flushTimer = null;
  const ks = [...dirty]; dirty.clear();
  for (const k of ks) { try { await kvSet(k, valOf(k)); } catch (e) { console.error('Lỗi lưu', k, e.message); dirty.add(k); if (!flushTimer) flushTimer = setTimeout(flush, 5000); } }
}
async function loadAll() {
  try {
    const [c, st, l, h, cs] = await Promise.all([kvGet('config'), kvGet('students'), kvGet('lb'), kvGet('history'), kvGet('sessions')]);
    if (c && c.texts) cfg = c; if (st) ST = st; if (l) LB = l; if (h) history = h; if (Array.isArray(cs)) CS = cs;
    console.log(DB ? 'Lưu trữ: Upstash Redis (vĩnh viễn). Sinh viên: ' + Object.keys(ST).length : 'CẢNH BÁO: chưa cấu hình Upstash – dữ liệu lưu file tạm, sẽ mất khi Render khởi động lại.');
  } catch (e) { console.error('Không đọc được dữ liệu, dừng để tránh ghi đè:', e.message); process.exit(1); }
}
process.on('SIGTERM', async () => { await flush(); process.exit(0); });
let cfg = { duration: 2, texts: [
 { title: 'Hà Nội mùa thu', text: 'Hà Nội vào thu, những cơn gió se lạnh len qua từng con phố nhỏ. Hương hoa sữa thoang thoảng trong không khí khiến lòng người chợt dịu lại. Trên hè phố, người ta ngồi bên tách cà phê nóng, lặng lẽ ngắm lá vàng rơi. Mùa thu ở đây không ồn ào mà sâu lắng, như một bản nhạc cũ nhẹ nhàng ngân vang trong ký ức của mỗi người con đất Việt.' },
 { title: 'Giá trị của việc học', text: 'Học tập không chỉ là việc ghi nhớ kiến thức mà còn là quá trình rèn luyện tư duy và nhân cách. Mỗi sinh viên cần biết đặt câu hỏi, dám thử nghiệm và không sợ thất bại. Thành công không đến từ may mắn, mà đến từ sự kiên trì mỗi ngày. Khi chúng ta chịu khó luyện tập, những điều tưởng chừng khó khăn sẽ dần trở nên quen thuộc và đơn giản hơn rất nhiều.' },
 { title: 'Công nghệ và cuộc sống', text: 'Công nghệ thông tin đã thay đổi hoàn toàn cách con người làm việc, học tập và giao tiếp. Chỉ với một chiếc máy tính kết nối mạng, chúng ta có thể tiếp cận kho tri thức khổng lồ của nhân loại. Tuy nhiên, việc sử dụng công nghệ một cách thông minh và có trách nhiệm mới là điều quan trọng nhất. Kỹ năng gõ phím nhanh và chính xác là nền tảng giúp mọi người làm việc hiệu quả hơn.' }
] };

// Danh bạ sinh viên: MSSV (duy nhất) -> họ tên
let ST = {};
let CS = []; // các buổi thi theo lớp đã kết thúc (lưu vĩnh viễn)
const saveST = () => save('students');
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
const active = new Map(); // MSSV đang được sử dụng -> ws
const releaseId = ws => { if (ws.mssv && active.get(ws.mssv) === ws) active.delete(ws.mssv); };

// Bảng xếp hạng (điểm cao nhất của mỗi thí sinh theo từng loại thời gian)
let LB = [];
const saveLB = () => save('lb');
function recordLB(x, dur) {
  if (!x.score || !x.mssv) return;
  const e = LB.find(o => o.dur === dur && o.mssv === x.mssv);
  const row = { mssv: x.mssv, name: x.name, dur, score: x.score, wpm: x.wpm, acc: x.acc, at: Date.now() };
  if (!e) LB.push(row); else if (x.score > e.score || (x.score === e.score && x.acc > e.acc)) Object.assign(e, row);
}
function lbData() {
  const o = {};
  for (let d = 1; d <= 5; d++) o[d] = LB.filter(e => e.dur === d && e.mssv).sort((a, b) => b.score - a.score || b.acc - a.acc || a.at - b.at).slice(0, 50);
  return o;
}

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
    if (e) { res.writeHead(500); return res.end('Lỗi'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
  });
});
const wss = new WebSocketServer({ server });
const waiting = new Map(), rooms = new Map(), admins = new Set(), procs = new Set();
const isStaff = ws => admins.has(ws) || procs.has(ws); // cả 2 loại giám thị
const staffSend = msg => { admins.forEach(w => send(w, msg)); procs.forEach(w => send(w, msg)); };
let history = [];
let seq = 0;
const prep = t => String(t).normalize('NFC').replace(/\s+/g, ' ').trim();
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

// Chấm điểm theo từ (giống Monkeytype / 10FastFingers): từ gõ sai chỉ mất điểm của chính từ đó,
// không làm lệch các từ phía sau. Chỉ từ gõ đúng hoàn toàn mới tính vào tốc độ.
function stat(p, r, now) {
  const T = r.words, tw = p.typed.split(' ');
  let c = 0, tot = 0;
  tw.forEach((w, i) => {
    const last = i === tw.length - 1, tg = T[i];
    tot += w.length + (last ? 0 : 1);
    if (tg === undefined || !w) return;
    if (!last) { if (w === tg) c += w.length + 1; }
    else if (tg.startsWith(w)) c += w.length;
  });
  const end = Math.min(p.doneAt || now, r.endAt, now), m = Math.max(0, end - r.startAt) / 60000;
  const wpm = m > 0.008 ? c / 5 / m : 0, acc = tot ? 100 * c / tot : 100;
  return { name: p.name, mssv: p.mssv, correct: c, len: r.text.length, wpm: +wpm.toFixed(1), acc: +acc.toFixed(1), score: Math.round(wpm * (acc / 100) ** 2), done: !!p.doneAt };
}
function specMsg(r, now, ps) {
  return { t: 'spec', id: r.id, status: r.status, solo: r.solo, dur: r.dur, players: ps, toStart: r.startAt ? r.startAt - now : 0, toEnd: r.endAt ? r.endAt - now : 0, result: r.result || null };
}
function unwatch(ws) { if (ws.watching && ws.watching.watchers) ws.watching.watchers.delete(ws); ws.watching = null; }
function broadcast(r, extra) {
  const now = Date.now(), ps = r.players.map(p => stat(p, r, now));
  if (r.watchers) r.watchers.forEach(w => send(w, specMsg(r, now, ps)));
  r.players.forEach((p, i) => send(p.ws, Object.assign({
    t: 'state', status: r.status, me: i, solo: r.solo, dur: r.dur, players: ps,
    toStart: r.startAt ? r.startAt - now : 0, toEnd: r.endAt ? r.endAt - now : 0,
    text: (r.status === 'running' || r.status === 'finished') ? r.text : '', result: r.result || null
  }, extra)));
}
function pushAdmin() {
  const live = [...rooms.values()].map(r => ({ id: r.id, names: r.players.map(p => p.name), status: r.status }));
  const students = Object.entries(ST).map(([mssv, v]) => ({ mssv, name: v.name }));
  const clsInfo = AC ? { code: AC.code, status: AC.status, total: AC.players.length } : null;
  procs.forEach(ws => send(ws, { t: 'admin', role: 2, cfg: { duration: cfg.duration, texts: cfg.texts.map(t => ({ title: t.title })) }, cls: clsInfo, sessions: classSummaries() }));
  admins.forEach(ws => send(ws, { t: 'admin', role: 1, cfg, live, students, history: history.slice(-200), lb: lbData(), persist: DB, cls: AC ? { code: AC.code, status: AC.status, total: AC.players.length } : null, sessions: classSummaries() }));
}
function start(r) {
  r.status = 'countdown'; const now = Date.now();
  r.startAt = now + (r.solo ? 3000 : 5000); r.endAt = r.startAt + r.dur * 60000;
  broadcast(r);
  r.t1 = setTimeout(() => { r.status = 'running'; broadcast(r); }, r.startAt - now);
  r.t2 = setTimeout(() => finish(r), r.endAt - now + 300);
  r.tick = setInterval(() => { if (r.status === 'running') broadcast(r); }, 1000);
  pushAdmin();
}
function finish(r) {
  if (r.status === 'finished') return;
  r.status = 'finished'; clearTimeout(r.t1); clearTimeout(r.t2); clearInterval(r.tick);
  const now = Date.now(), s = r.players.map(p => stat(p, r, now));
  let w = -1;
  if (s.length === 2) {
    const d = s[0].score - s[1].score || s[0].acc - s[1].acc;
    w = d > 0 ? 0 : d < 0 ? 1 : -1;
    if (r.players[0].left && !r.players[1].left) w = 1;
    if (r.players[1].left && !r.players[0].left) w = 0;
  }
  r.result = { winner: w };
  s.forEach((x, i) => { if (!r.players[i].left) recordLB(x, r.dur); }); saveLB(); // cả thi đối kháng và thi một mình; bỏ cuộc giữa chừng thì không tính
  if (!r.solo) { history.push({ at: Date.now(), players: s, winner: w }); if (history.length > 3000) history.shift(); save('history'); }
  r.players.forEach(p => releaseId(p.ws));
  broadcast(r); rooms.delete(r.id); pushAdmin();
}
function leaveRoom(ws, explicit) {
  releaseId(ws);
  leaveClass(ws, explicit);
  const r = ws.room; if (!r) return; ws.room = null;
  if (r.status === 'waiting') { rooms.delete(r.id); if (waiting.get(r.code) === r) waiting.delete(r.code); }
  else if (r.status === 'countdown') {
    clearTimeout(r.t1); clearTimeout(r.t2); clearInterval(r.tick); rooms.delete(r.id);
    r.players.forEach(p => { if (p.ws !== ws) { p.ws.room = null; send(p.ws, { t: 'aborted' }); } });
  } else if (r.status === 'running') {
    const p = r.players.find(x => x.ws === ws); p.left = true; p.doneAt = Date.now();
    if (r.solo || r.players.every(x => x.doneAt)) finish(r); else broadcast(r);
  }
  pushAdmin();
}
// Xác thực MSSV + họ tên; trả về {mssv,name} hoặc undefined (đã báo lỗi cho client)
function identify(ws, m) {
  const mssv = String(m.mssv || '').trim().toUpperCase(), nm = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (nm.length < 2) return send(ws, { t: 'joinerr', msg: 'Vui lòng nhập họ tên.' });
  if (!/^[A-Z0-9]{5,15}$/.test(mssv)) return send(ws, { t: 'joinerr', msg: 'MSSV không hợp lệ (5–15 ký tự chữ hoặc số, ví dụ TH12345).' });
  const st = ST[mssv];
  if (st && norm(st.name) !== norm(nm)) return send(ws, { t: 'joinerr', msg: 'MSSV ' + mssv + ' đã được đăng ký với họ tên khác. Hãy nhập đúng họ tên đã dùng lần đầu (hoặc nhờ giám thị sửa).' });
  const cur = active.get(mssv);
  if (cur && cur !== ws && cur.readyState === 1) return send(ws, { t: 'joinerr', msg: 'MSSV này đang được sử dụng ở một thiết bị hoặc tab khác.' });
  leaveRoom(ws, true);
  if (!st) { ST[mssv] = { name: nm, at: Date.now() }; saveST(); }
  const name = ST[mssv].name; active.set(mssv, ws); ws.mssv = mssv;
  return { mssv, name };
}
function join(ws, m) {
  const id = identify(ws, m); if (!id) return;
  const { mssv, name } = id;
  const code = String(m.code || 'auto').replace(/[^\w-]/g, '').slice(0, 20) || 'auto';
  const p = { ws, name, mssv, typed: '' };
  if (m.solo) {
    const t = cfg.texts[Math.floor(Math.random() * cfg.texts.length)];
    const r = { id: ++seq, solo: true, text: prep(t.text), words: prep(t.text).split(' '), dur: cfg.duration, players: [p], status: 'waiting' };
    rooms.set(r.id, r); ws.room = r; return start(r);
  }
  let r = waiting.get(code);
  if (r && r.players[0].ws.readyState === 1) {
    waiting.delete(code); r.players.push(p); ws.room = r; start(r);
  } else {
    const t = cfg.texts[Math.floor(Math.random() * cfg.texts.length)];
    r = { id: ++seq, code, solo: false, text: prep(t.text), words: prep(t.text).split(' '), dur: cfg.duration, players: [p], status: 'waiting' };
    rooms.set(r.id, r); waiting.set(code, r); ws.room = r;
    send(ws, { t: 'state', status: 'waiting', code, me: 0, players: [{ name }], text: '' }); pushAdmin();
  }
}
// ================= THI THEO LỚP (tối đa 1 lớp hoạt động) =================
let AC = null;
const rankCmp = (a, b) => b.s.score - a.s.score || b.s.acc - a.s.acc || b.s.correct - a.s.correct;
const slim = (s, p) => ({ name: s.name, mssv: s.mssv, score: s.score, wpm: s.wpm, acc: s.acc, correct: s.correct, len: s.len, done: s.done, disc: !!p.disc, left: !!p.left });
const clsSnap = (c, now) => c.players.map(p => ({ p, s: stat(p, c, now) })).sort(rankCmp);
const classSummaries = () => CS.slice().reverse().slice(0, 100).map(({ results, ...r }) => r);
function sendClsAdmin(c, extra) {
  const now = Date.now(), arr = clsSnap(c, now);
  const msg = Object.assign({ t: 'clsadmin', code: c.code, password: c.password, status: c.status, dur: c.dur, max: c.max, total: c.players.length,
    toStart: c.startAt ? c.startAt - now : 0, toEnd: c.endAt ? c.endAt - now : 0, players: arr.map(x => slim(x.s, x.p)) }, extra);
  staffSend(msg);
}
// Gửi trạng thái cho từng sinh viên: chỉ số liệu của riêng họ + top (không phát từng phím cho cả lớp)
function sendClsPlayers(c, withText, only) {
  const now = Date.now(), arr = clsSnap(c, now), n = arr.length, topN = c.status === 'finished' ? 10 : 5;
  const top = arr.slice(0, topN).map(x => ({ name: x.s.name, mssv: x.s.mssv, score: x.s.score, wpm: x.s.wpm, acc: x.s.acc }));
  arr.forEach((x, i) => {
    if (only && x.p !== only) return;
    send(x.p.ws, { t: 'state', status: c.status === 'open' ? 'waiting' : c.status, me: 0, solo: false, dur: c.dur, players: [x.s],
      toStart: c.startAt ? c.startAt - now : 0, toEnd: c.endAt ? c.endAt - now : 0, text: withText ? c.text : '', result: null,
      cls: { code: c.code, count: n, rank: i + 1, total: n, top } });
  });
}
function clsCreate(ws, m) {
  const err = msg => send(ws, { t: 'clserr', msg });
  if (AC) return err('Đang có lớp "' + AC.code + '" hoạt động. Hãy kết thúc hoặc hủy lớp đó trước (mỗi lúc chỉ có 1 lớp thi).');
  const code = String(m.code || '').trim().toUpperCase(), pw = String(m.password || '').trim().slice(0, 30);
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) return err('Mã lớp gồm 2–20 ký tự: chữ, số, dấu - hoặc _.');
  if (pw.length < 3) return err('Mật khẩu lớp tối thiểu 3 ký tự.');
  const d = Math.round(+m.dur), dur = d >= 1 && d <= 5 ? d : cfg.duration, max = Math.min(100, Math.max(2, Math.round(+m.max) || 60));
  const ti = Math.round(+m.textIdx), t = cfg.texts[ti >= 0 && ti < cfg.texts.length ? ti : Math.floor(Math.random() * cfg.texts.length)];
  AC = { code, password: pw, dur, max, status: 'open', players: [], text: prep(t.text), words: prep(t.text).split(' '), startAt: 0, endAt: 0 };
  const c = AC;
  c.tick = setInterval(() => { if (c.status !== 'finished' && c.status !== 'cancelled') { sendClsPlayers(c, false); sendClsAdmin(c); } }, 1000);
  sendClsAdmin(c); pushAdmin();
}
function clsStart(c) {
  const now = Date.now(); c.status = 'countdown'; c.startAt = now + 5000; c.endAt = c.startAt + c.dur * 60000;
  c.t1 = setTimeout(() => { if (c.status === 'countdown') { c.status = 'running'; sendClsPlayers(c, true); sendClsAdmin(c); } }, 5000);
  c.t2 = setTimeout(() => clsFinish(c), c.endAt - now + 300);
  sendClsPlayers(c, false); sendClsAdmin(c); pushAdmin();
}
function clsFinish(c) {
  if (c.status === 'finished' || c.status === 'cancelled') return;
  c.status = 'finished'; clearTimeout(c.t1); clearTimeout(c.t2); clearInterval(c.tick);
  const now = Date.now(), arr = clsSnap(c, now);
  const results = arr.map((x, i) => ({ rank: i + 1, mssv: x.s.mssv, name: x.s.name, score: x.s.score, wpm: x.s.wpm, acc: x.s.acc, correct: x.s.correct, len: x.s.len, done: x.s.done, left: !!x.p.left }));
  arr.forEach(x => { if (!x.p.left) recordLB(x.s, c.dur); }); saveLB();
  const ok = results.filter(r => !r.left), avg = k => ok.length ? Math.round(ok.reduce((a, r) => a + r[k], 0) / ok.length * 10) / 10 : 0;
  const sess = { id: Date.now(), code: c.code, dur: c.dur, at: c.startAt || now, count: ok.length, finished: ok.filter(r => r.done).length,
    avgScore: avg('score'), avgWpm: avg('wpm'), avgAcc: avg('acc'), maxScore: ok.length ? Math.max(...ok.map(r => r.score)) : 0, results };
  CS.push(sess); if (CS.length > 300) CS.shift(); save('sessions');
  sendClsPlayers(c, false); sendClsAdmin(c, { sid: sess.id });
  c.players.forEach(p => { releaseId(p.ws); if (p.ws) p.ws.cls = null; });
  AC = null; pushAdmin();
}
function clsCancel() {
  const c = AC; if (!c || (c.status !== 'open' && c.status !== 'countdown')) return;
  c.status = 'cancelled'; clearTimeout(c.t1); clearTimeout(c.t2); clearInterval(c.tick);
  c.players.forEach(p => { send(p.ws, { t: 'clsclosed' }); releaseId(p.ws); if (p.ws) p.ws.cls = null; });
  sendClsAdmin(c); AC = null; pushAdmin();
}
function joinClass(ws, m) {
  const c = AC, err = msg => send(ws, { t: 'joinerr', msg });
  if (!c) return err('Hiện không có lớp thi nào đang mở.');
  if ((ws.fails || 0) >= 10) return err('Bạn đã nhập sai quá nhiều lần. Hãy tải lại trang.');
  if (String(m.code || '').trim().toUpperCase() !== c.code || String(m.password || '') !== c.password) { ws.fails = (ws.fails || 0) + 1; return err('Sai mã lớp hoặc mật khẩu.'); }
  const id = identify(ws, m); if (!id) return;
  let p = c.players.find(x => x.mssv === id.mssv);
  if (p) { p.ws = ws; p.disc = false; } // vào lại sau khi mất kết nối
  else {
    if (c.status !== 'open') { releaseId(ws); return err('Lớp đã bắt đầu thi, không thể vào thêm.'); }
    if (c.players.length >= c.max) { releaseId(ws); return err('Lớp đã đủ sĩ số (' + c.max + ').'); }
    p = { ws, name: id.name, mssv: id.mssv, typed: '' }; c.players.push(p);
  }
  ws.cls = c; sendClsPlayers(c, c.status === 'running', p); sendClsAdmin(c);
}
function leaveClass(ws, explicit) {
  const c = ws.cls; if (!c) return; ws.cls = null;
  const p = c.players.find(x => x.ws === ws); if (!p) return;
  if (c.status === 'open') c.players = c.players.filter(x => x !== p);
  else if (explicit) { p.left = true; p.doneAt = p.doneAt || Date.now(); }
  else p.disc = true;
  if (c.status === 'running' && c.players.every(x => x.doneAt)) return clsFinish(c);
  if (c.status !== 'finished') sendClsAdmin(c);
}
function clsTyped(ws, m) {
  const c = ws.cls; if (!c || c.status !== 'running') return;
  const p = c.players.find(x => x.ws === ws); if (!p || p.doneAt) return;
  const v = String(m.text || '').normalize('NFC').replace(/\s+/g, ' ').replace(/^ /, '').slice(0, c.text.length + 40);
  if (v.length - p.typed.length > 25) return send(ws, { t: 'resync', text: p.typed });
  p.typed = v;
  const tw = v.split(' ');
  if (tw.length === c.words.length && tw[tw.length - 1] === c.words[c.words.length - 1]) {
    p.doneAt = Date.now(); sendClsPlayers(c, false, p);
    if (c.players.every(x => x.doneAt)) clsFinish(c);
  }
}

wss.on('connection', ws => {
  send(ws, { t: 'hello', duration: cfg.duration });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'join') join(ws, m);
    else if (m.t === 'leave') leaveRoom(ws, true);
    else if (m.t === 'joinclass') joinClass(ws, m);
    else if (m.t === 'watch' && admins.has(ws)) {
      unwatch(ws); const r = rooms.get(+m.id);
      if (!r) return send(ws, { t: 'spec', gone: true });
      (r.watchers = r.watchers || new Set()).add(ws); ws.watching = r;
      const now = Date.now(); send(ws, specMsg(r, now, r.players.map(p => stat(p, r, now))));
    }
    else if (m.t === 'unwatch') unwatch(ws);
    else if (m.t === 'lb') send(ws, { t: 'lb', data: lbData(), classes: classSummaries() });
    else if (m.t === 'clsres') { const x = CS.find(c => c.id === +m.id); send(ws, { t: 'clsres', session: x || null }); }
    else if (m.t === 'delstudent' && admins.has(ws)) { const k = String(m.mssv); delete ST[k]; LB = LB.filter(e => e.mssv !== k); saveST(); saveLB(); pushAdmin(); }
    else if (m.t === 'renstudent' && admins.has(ws)) {
      const k = String(m.mssv), nn = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (ST[k] && nn.length >= 2) { ST[k].name = nn; LB.forEach(e => { if (e.mssv === k) e.name = nn; }); saveST(); saveLB(); pushAdmin(); }
    }
    else if (m.t === 'resetlb' && admins.has(ws)) { if (+m.dur) LB = LB.filter(e => e.dur !== +m.dur); else LB = []; saveLB(); pushAdmin(); }
    else if (m.t === 'dellb' && admins.has(ws)) { LB = LB.filter(e => !(e.mssv === String(m.mssv) && e.dur === +m.dur)); saveLB(); pushAdmin(); }
    else if (m.t === 'delsession' && admins.has(ws)) { CS = CS.filter(x => x.id !== +m.id); save('sessions'); pushAdmin(); }
    else if (m.t === 'resetsessions' && admins.has(ws)) { CS = []; save('sessions'); pushAdmin(); }
    else if (m.t === 'clscreate' && isStaff(ws)) clsCreate(ws, m);
    else if (m.t === 'clsstart' && isStaff(ws)) { if (AC && AC.status === 'open' && AC.players.length) clsStart(AC); else send(ws, { t: 'clserr', msg: 'Chưa có sinh viên nào trong lớp.' }); }
    else if (m.t === 'clsend' && isStaff(ws)) { if (AC && AC.status === 'running') clsFinish(AC); }
    else if (m.t === 'clscancel' && isStaff(ws)) clsCancel();
    else if (m.t === 'resethist' && admins.has(ws)) { history = []; save('history'); pushAdmin(); }
    else if (m.t === 'resetall' && admins.has(ws) && m.confirm === 'XOA') { ST = {}; LB = []; history = []; CS = []; save('students', 'lb', 'history', 'sessions'); pushAdmin(); }
    else if (m.t === 'backup' && admins.has(ws)) send(ws, { t: 'backup', data: { config: cfg, students: ST, lb: LB, history, sessions: CS } });
    else if (m.t === 'restore' && admins.has(ws)) {
      const d = m.data;
      if (d && d.students && typeof d.students === 'object' && Array.isArray(d.lb) && Array.isArray(d.history)) {
        ST = d.students; LB = d.lb; history = d.history; if (Array.isArray(d.sessions)) CS = d.sessions; if (d.config && Array.isArray(d.config.texts) && d.config.texts.length) cfg = d.config;
        save('config', 'students', 'lb', 'history', 'sessions'); pushAdmin();
      }
    }
    else if (m.t === 'typed') {
      if (ws.cls) return clsTyped(ws, m);
      const r = ws.room; if (!r || r.status !== 'running') return;
      const p = r.players.find(x => x.ws === ws); if (p.doneAt) return;
      const v = String(m.text || '').normalize('NFC').replace(/\s+/g, ' ').replace(/^ /, '').slice(0, r.text.length + 40);
      if (v.length - p.typed.length > 12) return send(ws, { t: 'resync', text: p.typed }); // chặn dán văn bản
      p.typed = v;
      const tw = v.split(' '); // hoàn thành khi từ cuối cùng được gõ đúng hoàn toàn
      if (tw.length === r.words.length && tw[tw.length - 1] === r.words[r.words.length - 1]) p.doneAt = Date.now();
      broadcast(r); if (r.players.every(x => x.doneAt)) finish(r);
    } else if (m.t === 'admin') {
      if ((ws.afails || 0) >= 10) return send(ws, { t: 'adminfail' });
      if (m.pass === ADMIN_PASS) { procs.delete(ws); admins.add(ws); pushAdmin(); if (AC) sendClsAdmin(AC); }
      else if (PROCTOR_PASS && m.pass === PROCTOR_PASS) { admins.delete(ws); unwatch(ws); procs.add(ws); pushAdmin(); if (AC) sendClsAdmin(AC); }
      else { ws.afails = (ws.afails || 0) + 1; send(ws, { t: 'adminfail' }); }
    } else if (m.t === 'setcfg' && admins.has(ws)) {
      const d = Math.round(+m.duration), tx = (m.texts || []).filter(t => t && t.text).map(t => ({ title: String(t.title || '').slice(0, 80), text: String(t.text).replace(/\s+/g, ' ').trim() }));
      if (d >= 1 && d <= 5 && tx.length) { cfg = { duration: d, texts: tx }; save('config'); }
      pushAdmin();
    }
  });
  ws.on('close', () => { unwatch(ws); admins.delete(ws); procs.delete(ws); leaveRoom(ws); });
});
loadAll().then(() => server.listen(PORT, () => console.log('Typing Pro chạy tại http://localhost:' + PORT)));

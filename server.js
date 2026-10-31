// Typing Pro - máy chủ: ghép cặp, giữ đồng hồ, chấm điểm (server-authoritative)
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const CF = path.join(__dirname, 'config.json');
let cfg = { duration: 2, texts: [
 { title: 'Hà Nội mùa thu', text: 'Hà Nội vào thu, những cơn gió se lạnh len qua từng con phố nhỏ. Hương hoa sữa thoang thoảng trong không khí khiến lòng người chợt dịu lại. Trên hè phố, người ta ngồi bên tách cà phê nóng, lặng lẽ ngắm lá vàng rơi. Mùa thu ở đây không ồn ào mà sâu lắng, như một bản nhạc cũ nhẹ nhàng ngân vang trong ký ức của mỗi người con đất Việt.' },
 { title: 'Giá trị của việc học', text: 'Học tập không chỉ là việc ghi nhớ kiến thức mà còn là quá trình rèn luyện tư duy và nhân cách. Mỗi sinh viên cần biết đặt câu hỏi, dám thử nghiệm và không sợ thất bại. Thành công không đến từ may mắn, mà đến từ sự kiên trì mỗi ngày. Khi chúng ta chịu khó luyện tập, những điều tưởng chừng khó khăn sẽ dần trở nên quen thuộc và đơn giản hơn rất nhiều.' },
 { title: 'Công nghệ và cuộc sống', text: 'Công nghệ thông tin đã thay đổi hoàn toàn cách con người làm việc, học tập và giao tiếp. Chỉ với một chiếc máy tính kết nối mạng, chúng ta có thể tiếp cận kho tri thức khổng lồ của nhân loại. Tuy nhiên, việc sử dụng công nghệ một cách thông minh và có trách nhiệm mới là điều quan trọng nhất. Kỹ năng gõ phím nhanh và chính xác là nền tảng giúp mọi người làm việc hiệu quả hơn.' }
] };
try { cfg = JSON.parse(fs.readFileSync(CF, 'utf8')); } catch (e) {}

// Danh bạ sinh viên: MSSV (duy nhất) -> họ tên
const STF = path.join(__dirname, 'students.json');
let ST = {};
try { ST = JSON.parse(fs.readFileSync(STF, 'utf8')); } catch (e) {}
const saveST = () => { try { fs.writeFileSync(STF, JSON.stringify(ST)); } catch (e) {} };
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
const active = new Map(); // MSSV đang được sử dụng -> ws
const releaseId = ws => { if (ws.mssv && active.get(ws.mssv) === ws) active.delete(ws.mssv); };

// Bảng xếp hạng (điểm cao nhất của mỗi thí sinh theo từng loại thời gian)
const LBF = path.join(__dirname, 'leaderboard.json');
let LB = [];
try { LB = JSON.parse(fs.readFileSync(LBF, 'utf8')); } catch (e) {}
const saveLB = () => { try { fs.writeFileSync(LBF, JSON.stringify(LB)); } catch (e) {} };
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
const waiting = new Map(), rooms = new Map(), admins = new Set(), history = [];
let seq = 0;
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

function stat(p, r, now) {
  const T = r.text, t = p.typed; let c = 0;
  for (let i = 0; i < t.length; i++) if (t[i] === T[i]) c++;
  const end = Math.min(p.doneAt || now, r.endAt, now), m = Math.max(0, end - r.startAt) / 60000;
  const wpm = m > 0.008 ? c / 5 / m : 0, acc = t.length ? 100 * c / t.length : 100;
  return { name: p.name, mssv: p.mssv, correct: c, len: T.length, wpm: +wpm.toFixed(1), acc: +acc.toFixed(1), score: Math.round(wpm * (acc / 100) ** 2), done: !!p.doneAt };
}
function broadcast(r, extra) {
  const now = Date.now(), ps = r.players.map(p => stat(p, r, now));
  r.players.forEach((p, i) => send(p.ws, Object.assign({
    t: 'state', status: r.status, me: i, solo: r.solo, dur: r.dur, players: ps,
    toStart: r.startAt ? r.startAt - now : 0, toEnd: r.endAt ? r.endAt - now : 0,
    text: (r.status === 'running' || r.status === 'finished') ? r.text : '', result: r.result || null
  }, extra)));
}
function pushAdmin() {
  const live = [...rooms.values()].map(r => ({ names: r.players.map(p => p.name), status: r.status }));
  const students = Object.entries(ST).map(([mssv, v]) => ({ mssv, name: v.name }));
  admins.forEach(ws => send(ws, { t: 'admin', cfg, live, students, history: history.slice(-200) }));
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
  if (!r.solo) { s.forEach(x => recordLB(x, r.dur)); saveLB(); }
  if (!r.solo) history.push({ at: Date.now(), players: s, winner: w });
  r.players.forEach(p => releaseId(p.ws));
  broadcast(r); rooms.delete(r.id); pushAdmin();
}
function leaveRoom(ws) {
  releaseId(ws);
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
function join(ws, m) {
  const mssv = String(m.mssv || '').trim().toUpperCase(), nm = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (nm.length < 2) return send(ws, { t: 'joinerr', msg: 'Vui lòng nhập họ tên.' });
  if (!/^[A-Z0-9]{5,15}$/.test(mssv)) return send(ws, { t: 'joinerr', msg: 'MSSV không hợp lệ (5–15 ký tự chữ hoặc số, ví dụ PH12345).' });
  const st = ST[mssv];
  if (st && norm(st.name) !== norm(nm)) return send(ws, { t: 'joinerr', msg: 'MSSV ' + mssv + ' đã được đăng ký với họ tên khác. Hãy nhập đúng họ tên đã dùng lần đầu (hoặc nhờ giám thị sửa).' });
  const cur = active.get(mssv);
  if (cur && cur !== ws && cur.readyState === 1) return send(ws, { t: 'joinerr', msg: 'MSSV này đang được sử dụng ở một thiết bị hoặc tab khác.' });
  leaveRoom(ws);
  if (!st) { ST[mssv] = { name: nm, at: Date.now() }; saveST(); }
  const name = ST[mssv].name; active.set(mssv, ws); ws.mssv = mssv;
  const code = String(m.code || 'auto').replace(/[^\w-]/g, '').slice(0, 20) || 'auto';
  const p = { ws, name, mssv, typed: '' };
  if (m.solo) {
    const t = cfg.texts[Math.floor(Math.random() * cfg.texts.length)];
    const r = { id: ++seq, solo: true, text: t.text.normalize('NFC'), dur: cfg.duration, players: [p], status: 'waiting' };
    rooms.set(r.id, r); ws.room = r; return start(r);
  }
  let r = waiting.get(code);
  if (r && r.players[0].ws.readyState === 1) {
    waiting.delete(code); r.players.push(p); ws.room = r; start(r);
  } else {
    const t = cfg.texts[Math.floor(Math.random() * cfg.texts.length)];
    r = { id: ++seq, code, solo: false, text: t.text.normalize('NFC'), dur: cfg.duration, players: [p], status: 'waiting' };
    rooms.set(r.id, r); waiting.set(code, r); ws.room = r;
    send(ws, { t: 'state', status: 'waiting', code, me: 0, players: [{ name }], text: '' }); pushAdmin();
  }
}
wss.on('connection', ws => {
  send(ws, { t: 'hello', duration: cfg.duration });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'join') join(ws, m);
    else if (m.t === 'leave') leaveRoom(ws);
    else if (m.t === 'lb') send(ws, { t: 'lb', data: lbData() });
    else if (m.t === 'delstudent' && admins.has(ws)) { const k = String(m.mssv); delete ST[k]; LB = LB.filter(e => e.mssv !== k); saveST(); saveLB(); pushAdmin(); }
    else if (m.t === 'renstudent' && admins.has(ws)) {
      const k = String(m.mssv), nn = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (ST[k] && nn.length >= 2) { ST[k].name = nn; LB.forEach(e => { if (e.mssv === k) e.name = nn; }); saveST(); saveLB(); pushAdmin(); }
    }
    else if (m.t === 'resetlb' && admins.has(ws)) { LB = []; saveLB(); pushAdmin(); }
    else if (m.t === 'typed') {
      const r = ws.room; if (!r || r.status !== 'running') return;
      const p = r.players.find(x => x.ws === ws); if (p.doneAt) return;
      const v = String(m.text || '').normalize('NFC').slice(0, r.text.length);
      if (v.length - p.typed.length > 12) return send(ws, { t: 'resync', text: p.typed }); // chặn dán văn bản
      p.typed = v; if (v.length >= r.text.length) p.doneAt = Date.now();
      broadcast(r); if (r.players.every(x => x.doneAt)) finish(r);
    } else if (m.t === 'admin') {
      if (m.pass === ADMIN_PASS) { admins.add(ws); pushAdmin(); } else send(ws, { t: 'adminfail' });
    } else if (m.t === 'setcfg' && admins.has(ws)) {
      const d = Math.round(+m.duration), tx = (m.texts || []).filter(t => t && t.text).map(t => ({ title: String(t.title || '').slice(0, 80), text: String(t.text).replace(/\s+/g, ' ').trim() }));
      if (d >= 1 && d <= 5 && tx.length) { cfg = { duration: d, texts: tx }; try { fs.writeFileSync(CF, JSON.stringify(cfg, null, 1)); } catch (e) {} }
      pushAdmin();
    }
  });
  ws.on('close', () => { admins.delete(ws); leaveRoom(ws); });
});
server.listen(PORT, () => console.log('Typing Pro chạy tại http://localhost:' + PORT));

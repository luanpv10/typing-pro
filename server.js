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
  return { name: p.name, correct: c, len: T.length, wpm: +wpm.toFixed(1), acc: +acc.toFixed(1), score: Math.round(wpm * (acc / 100) ** 2), done: !!p.doneAt };
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
  admins.forEach(ws => send(ws, { t: 'admin', cfg, live, history: history.slice(-200) }));
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
  if (!r.solo) history.push({ at: Date.now(), players: s, winner: w });
  broadcast(r); rooms.delete(r.id); pushAdmin();
}
function leaveRoom(ws) {
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
  leaveRoom(ws);
  const name = String(m.name || 'Thí sinh').trim().slice(0, 30) || 'Thí sinh';
  const code = String(m.code || 'auto').replace(/[^\w-]/g, '').slice(0, 20) || 'auto';
  const p = { ws, name, typed: '' };
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

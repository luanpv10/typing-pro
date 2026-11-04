// Typing Pro - máy chủ: ghép cặp, giữ đồng hồ, chấm điểm (server-authoritative)
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000, ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
// Giám thị 1 (admin, toàn quyền): ADMIN_PASS. Giám thị 2 (chỉ quản lý thi theo lớp): PROCTOR_PASS (không đặt = tắt vai trò này).
const SECRET = process.env.SESSION_SECRET || (ADMIN_PASS + '|' + (process.env.PROCTOR_PASS || '') + '|typing-pro');
const makeToken = role => { const b = role + '.' + (Date.now() + 12 * 3600 * 1000); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('hex'); };
function verifyToken(tok) {
  const [role, exp, sig] = String(tok || '').split('.'); if (!sig || !(+exp > Date.now())) return 0;
  const ok = crypto.createHmac('sha256', SECRET).update(role + '.' + exp).digest('hex');
  try { if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return role === '1' ? 1 : (role === '2' && process.env.PROCTOR_PASS ? 2 : 0); } catch (e) {}
  return 0;
}
const CLASS_WAIT_MS = (+process.env.CLASS_WAIT_SEC || 600) * 1000; // lớp mở quá thời gian này mà chưa bắt đầu thi thì tự hủy (mặc định 10 phút)
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
    if (c && c.texts) cfg = Object.assign({ mode: 'preset', cpm: 400, classDur: 5 }, c); if (st) ST = st; if (l) LB = l; if (h) history = h; if (Array.isArray(cs)) CS = cs;
    if (c && c.texts && !c.v) { cfg.duration = 5; cfg.classDur = 5; cfg.v = 2; save('config'); } // cấu hình bản cũ: đặt lại mặc định 5 phút một lần
    backfillPlays();
    console.log(DB ? 'Lưu trữ: Upstash Redis (vĩnh viễn). Sinh viên: ' + Object.keys(ST).length : 'CẢNH BÁO: chưa cấu hình Upstash – dữ liệu lưu file tạm, sẽ mất khi Render khởi động lại.');
  } catch (e) { console.error('Không đọc được dữ liệu, dừng để tránh ghi đè:', e.message); process.exit(1); }
}
process.on('SIGTERM', async () => { await flush(); process.exit(0); });
let cfg = { v: 2, duration: 5, classDur: 5, mode: 'preset', cpm: 400, texts: [
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(d);
  });
});
const wss = new WebSocketServer({ server });
const waiting = new Map(), rooms = new Map(), admins = new Set(), procs = new Set();
const isStaff = ws => admins.has(ws) || procs.has(ws); // cả 2 loại giám thị
const staffSend = msg => { admins.forEach(w => send(w, msg)); procs.forEach(w => send(w, msg)); };
let history = [];
let seq = 0;
const prep = t => String(t).normalize('NFC').replace(/\s+/g, ' ').trim();
let onlineT = null;
const onlineCount = () => { let n = 0; wss.clients.forEach(c => { if (c.readyState === 1) n++; }); return n; };
function pushOnline() { // gom thông báo, tối đa 1 lần / 1,5 giây
  if (onlineT) return;
  onlineT = setTimeout(() => { onlineT = null; const n = onlineCount(); wss.clients.forEach(c => send(c, { t: 'online', n })); }, 1500);
}
// ===== Tạo đề thi theo thời gian =====
// Có 2 loại đề: 'preset' (chọn sẵn: ghép ngẫu nhiên các đoạn trong ngân hàng đề mẫu của giám thị 1)
// và 'random' (ngẫu nhiên: hệ thống tự ghép các câu từ kho câu có sẵn). Độ dài đề = số phút × cpm (ký tự/phút).
const SYS_SENTENCES = ["Buổi sáng, mặt trời lên cao và những tia nắng đầu tiên chiếu qua khung cửa sổ.", "Chăm chỉ luyện tập mỗi ngày là cách tốt nhất để gõ phím nhanh và chính xác hơn.", "Sông Hồng chảy qua thủ đô, mang theo phù sa bồi đắp cho những cánh đồng xanh mướt.", "Một cuốn sách hay có thể thay đổi cách chúng ta nhìn nhận về cuộc sống.", "Mưa rơi tí tách trên mái nhà, gợi nhớ những buổi chiều yên bình ở quê nhà.", "Công nghệ thông tin phát triển nhanh chóng, đòi hỏi mỗi người phải không ngừng học hỏi.", "Khi làm việc nhóm, mỗi thành viên cần biết lắng nghe và tôn trọng ý kiến của nhau.", "Phở bò nóng hổi với hành lá thơm lừng là món ăn sáng quen thuộc của người Hà Nội.", "Thành công không phải là đích đến mà là hành trình học hỏi và trưởng thành.", "Những chú chim sẻ nhảy nhót trên cành cây, hót vang một khúc nhạc vui tươi.", "Bạn đã bao giờ ngắm hoàng hôn trên biển và cảm thấy mọi lo toan bỗng nhẹ đi chưa?", "Kỹ năng quản lý thời gian giúp sinh viên cân bằng giữa việc học và cuộc sống.", "Đà Nẵng nổi tiếng với những bãi biển dài, cát trắng và nước biển trong xanh.", "Để viết mã tốt, lập trình viên cần suy nghĩ cẩn thận trước khi bắt tay vào gõ phím.", "Mùa xuân đến, hoa đào nở rộ khắp miền Bắc, hoa mai vàng rực rỡ khắp miền Nam.", "Tinh thần kỷ luật và sự kiên trì sẽ giúp bạn vượt qua mọi thử thách trong học tập.", "Chiếc xe đạp cũ của ông nội vẫn lăn bánh êm ái trên con đường làng quen thuộc.", "Internet giúp con người kết nối với nhau dù cách xa hàng nghìn cây số.", "Mỗi buổi tối, cả gia đình quây quần bên mâm cơm, kể cho nhau nghe chuyện trong ngày.", "Hãy đặt mục tiêu rõ ràng, chia nhỏ công việc và hoàn thành từng bước một.", "Cà phê sữa đá là thức uống được nhiều người yêu thích vào những ngày nắng nóng.", "Việc đọc sách mỗi ngày giúp mở rộng vốn từ và rèn luyện khả năng tư duy logic.", "Đồng bằng sông Cửu Long có hệ thống kênh rạch chằng chịt và những vườn trái cây trĩu quả.", "Một lời cảm ơn chân thành có thể làm cho người khác vui suốt cả ngày dài.", "Trước khi thi, hãy ngủ đủ giấc, ăn uống lành mạnh và giữ cho tinh thần thật thoải mái.", "Bầu trời đêm đầy sao khiến những người yêu thiên văn mê mẩn ngắm nhìn hàng giờ liền.", "Học ngoại ngữ không chỉ giúp ta giao tiếp mà còn mở ra nhiều cơ hội nghề nghiệp mới.", "Tiếng gió thổi qua rặng tre xào xạc, nghe như lời thì thầm của làng quê Việt Nam.", "Người giỏi không phải là người không bao giờ mắc lỗi mà là người biết rút kinh nghiệm.", "Trong lớp học, thầy cô luôn khuyến khích học sinh đặt câu hỏi và mạnh dạn trình bày ý kiến.", "Bánh chưng xanh, dưa hành và câu đối đỏ là những nét đẹp không thể thiếu ngày Tết.", "Máy tính xách tay nhỏ gọn giúp sinh viên học tập và làm việc ở bất cứ đâu.", "Sức khỏe là tài sản quý giá nhất, vì vậy hãy dành thời gian vận động mỗi ngày.", "Ánh đèn thành phố lung linh về đêm, phản chiếu trên mặt hồ yên ả.", "Muốn tiến bộ, chúng ta cần dũng cảm bước ra khỏi vùng an toàn của chính mình.", "Cô giáo mỉm cười, nhẹ nhàng giải thích lại bài toán cho cả lớp cùng hiểu.", "Vịnh Hạ Long với hàng nghìn đảo đá vôi là di sản thiên nhiên được cả thế giới biết đến.", "Thói quen tốt được hình thành từ những hành động nhỏ lặp đi lặp lại mỗi ngày.", "Trên sân trường, các bạn nhỏ chạy nhảy và cười đùa trong giờ ra chơi.", "An toàn thông tin là vấn đề quan trọng mà mọi người dùng mạng cần quan tâm.", "Một mùa gặt bội thu là niềm vui lớn của người nông dân sau những tháng ngày vất vả.", "Hãy kiểm tra kỹ lại bài làm trước khi nộp để tránh những sai sót đáng tiếc.", "Chợ nổi trên sông buổi sớm tấp nập ghe thuyền chở đầy rau củ và trái cây.", "Sự sáng tạo bắt đầu từ việc dám nghĩ khác và dám thử những điều mới mẻ.", "Tiếng trống trường vang lên, báo hiệu một năm học mới đã bắt đầu.", "Gõ mười ngón đúng cách giúp tay không mỏi và tốc độ tăng lên rõ rệt theo thời gian.", "Cầu Rồng ở Đà Nẵng phun lửa và nước vào mỗi tối cuối tuần, thu hút rất đông du khách.", "Khi gặp khó khăn, đừng ngại nhờ bạn bè và thầy cô giúp đỡ vì ai cũng từng như vậy.", "Hương cốm mới thoang thoảng trong gió thu làm lòng người xao xuyến.", "Dữ liệu là nguồn tài nguyên quý giá, cần được bảo vệ và sử dụng có trách nhiệm.", "Những con đường rợp bóng cây xanh làm cho thành phố trở nên mát mẻ và dễ chịu hơn.", "Thời gian trôi qua rất nhanh, vì vậy hãy trân trọng từng giây phút bên người thân.", "Mỗi dự án thành công đều bắt đầu từ một kế hoạch rõ ràng và một đội ngũ đoàn kết.", "Nghe nhạc nhẹ khi làm việc giúp tinh thần thư giãn và tập trung hơn.", "Ngôi chùa cổ nằm yên bình giữa rừng thông, chuông ngân vang trong sương sớm.", "Biết ơn những điều giản dị xung quanh sẽ giúp chúng ta sống hạnh phúc hơn.", "Muốn có một bài thuyết trình hay, bạn cần chuẩn bị nội dung và luyện nói nhiều lần.", "Cơn gió mát từ biển thổi vào đất liền, mang theo vị mặn của muối và hương của nắng.", "Ai cũng có điểm mạnh riêng, quan trọng là ta biết phát huy nó đúng lúc, đúng chỗ.", "Bữa cơm gia đình giản dị nhưng ấm áp luôn là ký ức đẹp nhất của mỗi người con xa quê.", "Phần mềm tốt phải dễ dùng, chạy ổn định và đáp ứng đúng nhu cầu của người sử dụng.", "Chúng ta học không chỉ để có điểm số mà còn để hiểu biết và trở thành người có ích.", "Con đường đến thành công luôn có những khúc quanh, nhưng người kiên trì sẽ về đích.", "Cuối tuần, cả nhóm cùng nhau đi dã ngoại, hát hò và chơi trò chơi dưới tán cây xanh."];
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const splitSent = t => prep(t).split(/(?<=[.!?…])\s+/).filter(Boolean);
function buildExam(dur, mode) {
  const target = dur * (cfg.cpm || 400);
  const units = (mode === 'random' || !cfg.texts.length) ? SYS_SENTENCES.map(x => [x]) : cfg.texts.map(t => splitSent(t.text));
  const idx = () => shuffle(units.map((_, i) => i));
  let order = idx(), k = 0, len = 0, guard = 0; const out = [];
  while (len < target && guard++ < 5000) {
    if (k >= order.length) { const last = order[order.length - 1]; order = idx(); if (order.length > 1 && order[0] === last) order.push(order.shift()); k = 0; }
    const u = units[order[k++]], need = target - len, full = u.join(' ');
    if (u.length === 1 || full.length <= need * 1.3) { out.push(full); len += full.length + 1; }
    else { const part = []; let l = 0; for (const sn of u) { part.push(sn); l += sn.length + 1; if (l >= need) break; } out.push(part.join(' ')); len += l; }
  }
  return prep(out.join(' '));
}
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

// Chấm điểm theo từ (giống Monkeytype / 10FastFingers): từ gõ sai chỉ mất điểm của chính từ đó,
// không làm lệch các từ phía sau. Chỉ từ gõ đúng hoàn toàn mới tính vào tốc độ.
// Chống gian lận: kết hợp số liệu bàn phím thật do trình duyệt gửi (keydown isTrusted) với kiểm tra tốc độ/nhịp gõ ở máy chủ.
function checkCheat(p, m, now) {
  if (p.cheat) return true;
  const len = p.typed.length, tl = m.tl;
  (p.hist = p.hist || []).push({ t: now, len });
  while (p.hist.length > 2 && now - p.hist[0].t > 6000) p.hist.shift();
  const h0 = p.hist[0], dt = now - h0.t; let why = '';
  const h1 = p.hist.find(x => x.t >= now - 1500); // cửa sổ ngắn: dán/bơm chữ cực nhanh
  if (h1 && now - h1.t >= 400 && (len - h1.len) / ((now - h1.t) / 1000) > 35) why = 'Tốc độ gõ vượt giới hạn của con người';
  else if (dt >= 3000 && (len - h0.len) / (dt / 1000) > 18) why = 'Tốc độ gõ vượt giới hạn của con người';
  if (tl && !why) {
    const kd = +tl.kd || 0, sd = +tl.sd, sy = +tl.sy || 0, bl = +tl.bl || 0;
    if (tl.wd) why = 'Trình duyệt bị điều khiển tự động';
    else if (len >= 40 && kd < len * 0.5) why = 'Chữ xuất hiện không qua thao tác bàn phím thật';
    else if (kd >= 60 && sd >= 0 && sd < 12) why = 'Nhịp gõ đều như máy';
    else if (sy >= 3) why = 'Có sự kiện nhập giả lập (không phải bàn phím thật)';
    if (!why && bl >= 4) p.warn = 'Rời khỏi trang ' + bl + ' lần';
  } else if (!tl && len >= 30) p.warn = 'Thiếu dữ liệu kiểm tra từ trình duyệt';
  if (why) { p.cheat = why; p.doneAt = p.doneAt || now; return true; }
  return false;
}
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
  return { name: p.name, mssv: p.mssv, correct: c, len: r.text.length, wpm: +wpm.toFixed(1), acc: +acc.toFixed(1), score: p.cheat ? 0 : Math.round(wpm * (acc / 100) ** 2), done: !!p.doneAt, cheat: p.cheat || '', warn: p.warn || '' };
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
  procs.forEach(ws => send(ws, { t: 'admin', role: 2, cfg: { duration: cfg.classDur || 5 }, cls: clsInfo, sessions: classSummaries() }));
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
  r.players.forEach(p => bumpPlay(p.mssv));
  const now = Date.now(), s = r.players.map(p => stat(p, r, now));
  let w = -1;
  if (s.length === 2) {
    const d = s[0].score - s[1].score || s[0].acc - s[1].acc;
    w = d > 0 ? 0 : d < 0 ? 1 : -1;
    if (r.players[0].left && !r.players[1].left) w = 1;
    if (r.players[1].left && !r.players[0].left) w = 0;
  }
  r.result = { winner: w, early: !!(r.solo && r.players[0] && r.players[0].early) };
  s.forEach((x, i) => { if (!r.players[i].left && !r.players[i].early) recordLB(x, r.dur); }); saveLB(); // cả thi đối kháng và thi một mình; bỏ cuộc giữa chừng thì không tính
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
    const sd = Math.round(+m.dur), sdur = sd >= 1 && sd <= 5 ? sd : 2; // thi một mình: mặc định 2 phút
    const ex = buildExam(sdur, cfg.mode);
    const r = { id: ++seq, solo: true, text: ex, words: ex.split(' '), dur: sdur, players: [p], status: 'waiting' };
    rooms.set(r.id, r); ws.room = r; return start(r);
  }
  let r = waiting.get(code);
  if (r && r.players[0].ws.readyState === 1) {
    waiting.delete(code); r.players.push(p); ws.room = r; start(r);
  } else {
    const ex = buildExam(cfg.duration, cfg.mode);
    r = { id: ++seq, code, solo: false, text: ex, words: ex.split(' '), dur: cfg.duration, players: [p], status: 'waiting' };
    rooms.set(r.id, r); waiting.set(code, r); ws.room = r;
    send(ws, { t: 'state', status: 'waiting', code, me: 0, players: [{ name }], text: '' }); pushAdmin();
  }
}
// ================= THI THEO LỚP (tối đa 1 lớp hoạt động) =================
let AC = null;
const rankCmp = (a, b) => b.s.score - a.s.score || b.s.acc - a.s.acc || b.s.correct - a.s.correct;
const slim = (s, p) => ({ name: s.name, mssv: s.mssv, score: s.score, wpm: s.wpm, acc: s.acc, correct: s.correct, len: s.len, done: s.done, disc: !!p.disc, left: !!p.left, cheat: s.cheat, warn: s.warn });
const clsSnap = (c, now) => c.players.map(p => ({ p, s: stat(p, c, now) })).sort(rankCmp);
// ===== Thống kê số lần thi (mỗi lượt thi đều tính, kể cả khi không đạt điểm cao hơn) =====
function bumpPlay(mssv) { if (ST[mssv]) { ST[mssv].plays = (ST[mssv].plays || 0) + 1; save('students'); } }
function backfillPlays() { // dữ liệu cũ chưa có số lần thi: ước lượng tối thiểu từ lịch sử, lớp và bảng xếp hạng (chạy một lần)
  let changed = false;
  for (const [k, v] of Object.entries(ST)) {
    if (typeof v.plays === 'number') continue;
    const h = history.reduce((n, x) => n + x.players.filter(p => p.mssv === k).length, 0);
    const c = CS.reduce((n, x) => n + x.results.filter(r => r.mssv === k).length, 0);
    v.plays = Math.max(h + c, LB.filter(e => e.mssv === k).length); changed = true;
  }
  if (changed) save('students');
}
function lbStats() {
  const part = new Set();
  Object.entries(ST).forEach(([k, v]) => { if ((v.plays || 0) > 0) part.add(k); });
  LB.forEach(e => e.mssv && part.add(e.mssv));
  CS.forEach(c => c.results.forEach(r => r.mssv && part.add(r.mssv)));
  history.forEach(h => h.players.forEach(p => p.mssv && part.add(p.mssv)));
  let max = 0; Object.values(ST).forEach(v => { if ((v.plays || 0) > max) max = v.plays; });
  const people = Object.entries(ST).filter(([k, v]) => max > 0 && (v.plays || 0) === max).map(([k, v]) => ({ mssv: k, name: v.name }));
  return { students: part.size, classes: new Set(CS.map(c => c.code)).size, most: { plays: max, people: people.slice(0, 5), more: Math.max(0, people.length - 5) } };
}
function classTop() {
  const best = new Map();
  CS.forEach(x => x.results.forEach(r => {
    if (r.left || r.cheat || !r.score) return; const b = best.get(r.mssv);
    if (!b || r.score > b.score || (r.score === b.score && r.acc > b.acc)) best.set(r.mssv, { mssv: r.mssv, name: r.name, code: x.code, score: r.score, wpm: r.wpm, acc: r.acc });
  }));
  return [...best.values()].sort((a, b) => b.score - a.score || b.acc - a.acc).slice(0, 30);
}
const classSummaries = () => CS.slice().reverse().slice(0, 100).map(({ results, ...r }) => r);
function grant(ws, role) {
  if (role === 1) { procs.delete(ws); admins.add(ws); } else { admins.delete(ws); unwatch(ws); procs.add(ws); }
  pushAdmin(); if (AC) sendClsAdmin(AC);
}
function sendClsAdmin(c, extra) {
  const now = Date.now(), arr = clsSnap(c, now);
  const msg = Object.assign({ t: 'clsadmin', code: c.code, password: c.password, status: c.status, dur: c.dur, max: c.max, total: c.players.length,
    toStart: c.startAt ? c.startAt - now : 0, toEnd: c.endAt ? c.endAt - now : 0, toExpire: c.status === 'open' && c.expireAt ? c.expireAt - now : 0, players: arr.map(x => slim(x.s, x.p)) }, extra);
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
  if (CS.some(x => x.code === code)) return err('Mã lớp "' + code + '" đã được dùng cho một buổi thi trước đó. Mỗi mã lớp chỉ dùng một lần, hãy đặt mã khác (hoặc nhờ giám thị 1 xóa thống kê buổi thi cũ).');
  if (pw.length < 3) return err('Mật khẩu lớp tối thiểu 3 ký tự.');
  const dur = cfg.classDur || 5, max = Math.min(100, Math.max(2, Math.round(+m.max) || 60));
  const mode = admins.has(ws) && (m.mode === 'preset' || m.mode === 'random') ? m.mode : cfg.mode, ex = buildExam(dur, mode); // giám thị 2 luôn theo cấu hình chung
  AC = { code, password: pw, dur, max, status: 'open', players: [], text: ex, words: ex.split(' '), startAt: 0, endAt: 0 };
  const c = AC;
  c.expireAt = Date.now() + CLASS_WAIT_MS;
  c.expire = setTimeout(() => { if (AC === c && c.status === 'open') clsCancel('timeout'); }, CLASS_WAIT_MS);
  c.tick = setInterval(() => { if (c.status !== 'finished' && c.status !== 'cancelled') { sendClsPlayers(c, false); sendClsAdmin(c); } }, 1000);
  sendClsAdmin(c); pushAdmin();
}
function clsStart(c) {
  clearTimeout(c.expire);
  const now = Date.now(); c.status = 'countdown'; c.startAt = now + 5000; c.endAt = c.startAt + c.dur * 60000;
  c.t1 = setTimeout(() => { if (c.status === 'countdown') { c.status = 'running'; sendClsPlayers(c, true); sendClsAdmin(c); } }, 5000);
  c.t2 = setTimeout(() => clsFinish(c), c.endAt - now + 300);
  sendClsPlayers(c, false); sendClsAdmin(c); pushAdmin();
}
function clsFinish(c) {
  if (c.status === 'finished' || c.status === 'cancelled') return;
  c.status = 'finished'; clearTimeout(c.t1); clearTimeout(c.t2); clearTimeout(c.expire); clearInterval(c.tick);
  const now = Date.now(), arr = clsSnap(c, now);
  const results = arr.map((x, i) => ({ rank: i + 1, mssv: x.s.mssv, name: x.s.name, score: x.s.score, wpm: x.s.wpm, acc: x.s.acc, correct: x.s.correct, len: x.s.len, done: x.s.done, left: !!x.p.left, cheat: x.s.cheat }));
  arr.forEach(x => bumpPlay(x.p.mssv));
  arr.forEach(x => { if (!x.p.left) recordLB(x.s, c.dur); }); saveLB();
  const ok = results.filter(r => !r.left && !r.cheat), avg = k => ok.length ? Math.round(ok.reduce((a, r) => a + r[k], 0) / ok.length * 10) / 10 : 0;
  const sess = { id: Date.now(), code: c.code, dur: c.dur, at: c.startAt || now, count: ok.length, finished: ok.filter(r => r.done).length,
    avgScore: avg('score'), avgWpm: avg('wpm'), avgAcc: avg('acc'), maxScore: ok.length ? Math.max(...ok.map(r => r.score)) : 0, results };
  CS.push(sess); if (CS.length > 300) CS.shift(); save('sessions');
  sendClsPlayers(c, false); sendClsAdmin(c, { sid: sess.id });
  c.players.forEach(p => { releaseId(p.ws); if (p.ws) p.ws.cls = null; });
  AC = null; pushAdmin();
}
function clsCancel(reason) {
  const c = AC; if (!c || (c.status !== 'open' && c.status !== 'countdown')) return;
  c.status = 'cancelled'; clearTimeout(c.t1); clearTimeout(c.t2); clearTimeout(c.expire); clearInterval(c.tick);
  c.players.forEach(p => { send(p.ws, { t: 'clsclosed', reason }); releaseId(p.ws); if (p.ws) p.ws.cls = null; });
  sendClsAdmin(c, { reason }); AC = null; pushAdmin();
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
  if (checkCheat(p, m, Date.now())) { send(ws, { t: 'cheat', reason: p.cheat }); sendClsPlayers(c, false, p); if (c.players.every(x => x.doneAt)) clsFinish(c); return; }
  const tw = v.split(' ');
  if (tw.length === c.words.length && tw[tw.length - 1] === c.words[c.words.length - 1]) {
    p.doneAt = Date.now(); sendClsPlayers(c, false, p);
    if (c.players.every(x => x.doneAt)) clsFinish(c);
  }
}

wss.on('connection', ws => {
  send(ws, { t: 'hello', duration: cfg.duration, online: onlineCount() }); pushOnline();
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'join') join(ws, m);
    else if (m.t === 'leave') leaveRoom(ws, true);
    else if (m.t === 'endsolo') { // thi một mình: kết thúc sớm (hiện kết quả, không ghi vào bảng xếp hạng)
      const r = ws.room;
      if (r && r.solo && r.status === 'running') { const p = r.players[0]; if (!p.doneAt) { p.early = true; p.doneAt = Date.now(); } finish(r); }
    }
    else if (m.t === 'joinclass') joinClass(ws, m);
    else if (m.t === 'resume') { const r = verifyToken(m.token); if (r) grant(ws, r); else send(ws, { t: 'resumefail' }); }
    else if (m.t === 'stafflogout') { admins.delete(ws); procs.delete(ws); unwatch(ws); }
    else if (m.t === 'watch' && admins.has(ws)) {
      unwatch(ws); const r = rooms.get(+m.id);
      if (!r) return send(ws, { t: 'spec', gone: true });
      (r.watchers = r.watchers || new Set()).add(ws); ws.watching = r;
      const now = Date.now(); send(ws, specMsg(r, now, r.players.map(p => stat(p, r, now))));
    }
    else if (m.t === 'unwatch') unwatch(ws);
    else if (m.t === 'lb') send(ws, { t: 'lb', data: lbData(), classes: classSummaries(), classTop: classTop(), stats: lbStats() });
    else if (m.t === 'clsres') { const x = CS.find(c => c.id === +m.id); send(ws, { t: 'clsres', session: x || null }); }
    else if (m.t === 'delstudent' && admins.has(ws)) { const k = String(m.mssv); delete ST[k]; LB = LB.filter(e => e.mssv !== k); saveST(); saveLB(); pushAdmin(); }
    else if (m.t === 'renstudent' && admins.has(ws)) {
      const k = String(m.mssv), nn = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (ST[k] && nn.length >= 2) { ST[k].name = nn; LB.forEach(e => { if (e.mssv === k) e.name = nn; }); saveST(); saveLB(); pushAdmin(); }
    }
    else if (m.t === 'resetlb' && admins.has(ws)) { if (+m.dur) LB = LB.filter(e => e.dur !== +m.dur); else LB = []; saveLB(); pushAdmin(); }
    else if (m.t === 'dellb' && admins.has(ws)) { LB = LB.filter(e => !(e.mssv === String(m.mssv) && e.dur === +m.dur)); saveLB(); pushAdmin(); }
    else if (m.t === 'rensession' && admins.has(ws)) {
      const x = CS.find(c => c.id === +m.id), code = String(m.code || '').trim().toUpperCase(), err = msg => send(ws, { t: 'clserr', msg });
      if (!x) return;
      if (!/^[A-Z0-9_-]{2,20}$/.test(code)) return err('Mã lớp gồm 2–20 ký tự: chữ, số, dấu - hoặc _.');
      if ((AC && AC.code === code) || CS.some(c => c !== x && c.code === code)) return err('Mã lớp "' + code + '" đã tồn tại. Mỗi mã lớp phải duy nhất.');
      x.code = code; save('sessions'); pushAdmin();
    }
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
        ST = d.students; LB = d.lb; history = d.history; if (Array.isArray(d.sessions)) CS = d.sessions; if (d.config && Array.isArray(d.config.texts)) cfg = Object.assign({ mode: 'preset', cpm: 400, classDur: 5 }, d.config);
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
      if (checkCheat(p, m, Date.now())) { send(ws, { t: 'cheat', reason: p.cheat }); broadcast(r); if (r.players.every(x => x.doneAt)) finish(r); return; }
      const tw = v.split(' '); // hoàn thành khi từ cuối cùng được gõ đúng hoàn toàn
      if (tw.length === r.words.length && tw[tw.length - 1] === r.words[r.words.length - 1]) p.doneAt = Date.now();
      broadcast(r); if (r.players.every(x => x.doneAt)) finish(r);
    } else if (m.t === 'admin') {
      if ((ws.afails || 0) >= 10) return send(ws, { t: 'adminfail' });
      if (m.pass === ADMIN_PASS) { grant(ws, 1); send(ws, { t: 'stafftoken', token: makeToken(1), role: 1 }); }
      else if (PROCTOR_PASS && m.pass === PROCTOR_PASS) { grant(ws, 2); send(ws, { t: 'stafftoken', token: makeToken(2), role: 2 }); }
      else { ws.afails = (ws.afails || 0) + 1; send(ws, { t: 'adminfail' }); }
    } else if (m.t === 'setcfg' && admins.has(ws)) {
      const d = Math.round(+m.duration), tx = (m.texts || []).filter(t => t && t.text).map(t => ({ title: String(t.title || '').slice(0, 80), text: String(t.text).replace(/\s+/g, ' ').trim().slice(0, 6000) }));
      const mode = m.mode === 'random' ? 'random' : 'preset', cpm = Math.min(800, Math.max(200, Math.round(+m.cpm) || 400));
      if (d >= 1 && d <= 5 && (tx.length || mode === 'random')) { const cdur = Math.round(+m.classDur); cfg = { v: 2, duration: d, classDur: cdur >= 1 && cdur <= 5 ? cdur : 5, mode, cpm, texts: tx.slice(0, 300) }; save('config'); }
      pushAdmin();
    }
  });
  ws.on('close', () => { pushOnline(); unwatch(ws); admins.delete(ws); procs.delete(ws); leaveRoom(ws); });
});
loadAll().then(() => server.listen(PORT, () => console.log('Typing Pro chạy tại http://localhost:' + PORT)));

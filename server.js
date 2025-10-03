// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ====== Конфиг администратора ======
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "Pers__2006)";

// ====== Простая «БД» в файлах ======
const DB_DIR = path.join(__dirname);
const BANS_FILE = path.join(DB_DIR, "bans.json");
const REPORTS_FILE = path.join(DB_DIR, "reports.json");

function readJSON(p) {
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw || "[]");
  } catch (e) {
    console.error("readJSON error", p, e);
    return [];
  }
}
function writeJSON(p, data) {
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("writeJSON error", p, e);
  }
}

let bans = readJSON(BANS_FILE);       // [{id,userId?,ip?,reason,until}]
let reports = readJSON(REPORTS_FILE); // [{id,fromUser,againstUser,reason,chatId,ts}]

// ====== Очередь ожидания для матчмейкинга ======
let waiting = []; // массив сокетов (или их легких оберток)

// ====== Возрастные диапазоны (18+) ======
const ALLOWED_RANGES = new Set(["18-22", "23-33", "34+"]);

function ageInRange(age, rangeKey) {
  const n = parseInt(age, 10);
  if (Number.isNaN(n)) return false;
  switch (rangeKey) {
    case "18-22": return n >= 18 && n <= 22;
    case "23-33": return n >= 23 && n <= 33;
    case "34+": return n >= 34;
    default: return false;
  }
}

// ====== Бан: проверки/утилиты ======
function isBanActive(b) {
  return !b.until || Date.now() < b.until;
}
function getActiveBanFor(userId, ip) {
  // prioritise userId, fallback to IP
  const now = Date.now();
  return bans.find(
    (b) =>
      isBanActive(b) &&
      ((userId && b.userId && b.userId === userId) ||
        (ip && b.ip && b.ip === ip))
  );
}
function banToPublic(b) {
  return {
    id: b.id,
    userId: b.userId || null,
    ip: b.ip || null,
    reason: b.reason || "",
    until: b.until || null,
  };
}

// ====== Матчинг по полу/возрасту/стране ======
function matches(me, other) {
  if (!other) return false;
  const genderOk = me.targetGender === "any" || me.targetGender === other.myGender;
  const partnerGenderOk = other.targetGender === "any" || other.targetGender === me.myGender;

  const ageOk = !me.targetAges.length || me.targetAges.some((r) => ageInRange(other.myAge, r));
  const partnerAgeOk = !other.targetAges.length || other.targetAges.some((r) => ageInRange(me.myAge, r));

  const countryOk = !me.targetCountry || me.targetCountry === "any" || me.targetCountry === other.myCountry;
  const partnerCountryOk = !other.targetCountry || other.targetCountry === "any" || other.targetCountry === me.myCountry;

  return genderOk && partnerGenderOk && ageOk && partnerAgeOk && countryOk && partnerCountryOk;
}

function dropFromWaiting(sock) {
  const i = waiting.findIndex((s) => s.id === sock.id);
  if (i !== -1) waiting.splice(i, 1);
}

function getCountryCounts() {
  const counts = {};
  for (const s of waiting) {
    const c = (s.profile?.myCountry || "any");
    counts[c] = (counts[c] || 0) + 1;
  }
  return counts;
}

// ====== Socket.io ======
io.on("connection", (socket) => {
  const ip = socket.handshake.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || socket.handshake.address
    || "";
  const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId || null;

  socket.userId = userId;
  socket.userIp = ip;

  // Проверяем бан при подключении
  const ban = getActiveBanFor(userId, ip);
  if (ban) {
    socket.emit("banned", { reason: ban.reason || "Вы забанены", until: ban.until || null });
    // чуть задержим, чтобы клиент успел показать сообщение
    setTimeout(() => socket.disconnect(true), 150);
    return;
  }

  console.log("User connected:", socket.id, "userId:", userId, "ip:", ip);

  // Статистика стран (для модалки на клиенте)
  socket.on("get_country_counts", (ack) => {
    try {
      const counts = getCountryCounts();
      if (typeof ack === "function") ack({ ok: true, counts });
    } catch (e) {
      if (typeof ack === "function") ack({ ok: false, error: String(e) });
    }
  });

  // Поиск партнёра
  socket.on("find_partner", (data = {}) => {
    dropFromWaiting(socket);
    socket.partner = null;

    const myGender =
      data.myGender === "male" || data.myGender === "female" ? data.myGender : "any";
    const myAge = parseInt(data.myAge, 10) || 18;
    const myCountry = (data.myCountry && String(data.myCountry)) || "any";

    const targetGender =
      data.targetGender === "male" || data.targetGender === "female" ? data.targetGender : "any";
    let targetAges = Array.isArray(data.targetAges) ? data.targetAges : [];
    targetAges = targetAges.filter((k) => ALLOWED_RANGES.has(k));

    const targetCountry =
      data.targetCountry && String(data.targetCountry).length ? String(data.targetCountry) : "any";

    socket.profile = { myGender, myAge, myCountry, targetGender, targetAges, targetCountry };

    const partnerIndex = waiting.findIndex((s) => matches(socket.profile, s.profile));
    if (partnerIndex !== -1) {
      const partner = waiting[partnerIndex];
      waiting.splice(partnerIndex, 1);
      socket.partner = partner.id;
      partner.partner = socket.id;

      socket.emit("partner_found", { partnerId: partner.id });
      partner.emit("partner_found", { partnerId: socket.id });
      console.log("Paired:", socket.id, "<->", partner.id);
    } else {
      waiting.push(socket);
      console.log("Added to waiting:", socket.id, socket.profile);
    }
  });

  // Сообщения
  socket.on("message", (msg) => {
    if (socket.partner) io.to(socket.partner).emit("message", msg);
  });

  // Завершение чата
  socket.on("finish_chat", () => {
    dropFromWaiting(socket);
    if (socket.partner) {
      io.to(socket.partner).emit("partner_left");
      const partnerSocket = io.sockets.sockets.get(socket.partner);
      if (partnerSocket) partnerSocket.partner = null;
      socket.partner = null;
    }
  });

  // Жалоба на пользователя
  // payload: { againstUser: "<userId или socketId>", reason: "<string>", chatId?: "<id>" }
  socket.on("report_user", (payload = {}, ack) => {
    try {
      const rec = {
        id: "r_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
        fromUser: socket.userId || socket.id,
        againstUser: payload.againstUser || null,
        reason: String(payload.reason || "unspecified"),
        chatId: payload.chatId || null,
        ts: Date.now(),
      };
      reports.push(rec);
      writeJSON(REPORTS_FILE, reports);
      if (typeof ack === "function") ack({ ok: true });
    } catch (e) {
      if (typeof ack === "function") ack({ ok: false, error: String(e) });
    }
  });

  // Отключение
  socket.on("disconnect", () => {
    dropFromWaiting(socket);
    if (socket.partner) {
      io.to(socket.partner).emit("partner_left");
      const partnerSocket = io.sockets.sockets.get(socket.partner);
      if (partnerSocket) partnerSocket.partner = null;
      socket.partner = null;
    }
    console.log("User disconnected:", socket.id);
  });
});

// ====== Админ-мидлвар ======
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token && token === ADMIN_TOKEN) return next();
  res.status(401).json({ ok: false, error: "Unauthorized" });
}

// ====== Админ-эндпоинты ======
// Список жалоб
app.get("/admin/reports", requireAdmin, (req, res) => {
  res.json({ ok: true, reports });
});

// Создать бан (мгновенно кикнет онлайн-пользователей)
app.post("/admin/ban", requireAdmin, (req, res) => {
  const { userId, ip, minutes = 60, reason = "rule violation" } = req.body || {};
  if (!userId && !ip) return res.status(400).json({ ok: false, error: "userId or ip required" });
  const until = Date.now() + Math.max(1, minutes) * 60 * 1000;
  const ban = {
    id: "b_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    userId: userId || null,
    ip: ip || null,
    reason,
    until,
  };
  bans.push(ban);
  writeJSON(BANS_FILE, bans);

  // Мгновенно отключаем всех подходящих
  for (const [id, s] of io.sockets.sockets) {
    if (!isBanActive(ban)) continue;
    const hit =
      (ban.userId && s.userId && s.userId === ban.userId) ||
      (ban.ip && s.userIp && s.userIp === ban.ip);
    if (hit) {
      s.emit("banned", { reason, until });
      setTimeout(() => s.disconnect(true), 150);
    }
  }

  res.json({ ok: true, ban: banToPublic(ban) });
});

// Список банов (активные и истёкшие)
app.get("/admin/bans", requireAdmin, (req, res) => {
  res.json({ ok: true, bans: bans.map(banToPublic) });
});

// Удалить бан
app.delete("/admin/ban/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const i = bans.findIndex((b) => b.id === id);
  if (i === -1) return res.status(404).json({ ok: false, error: "not found" });
  const removed = bans.splice(i, 1)[0];
  writeJSON(BANS_FILE, bans);
  res.json({ ok: true, removed: banToPublic(removed) });
});

// В КОНЦЕ server.js, перед server.listen(...)
app.get("/admin/panel", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Admin Panel</title>
<style>body{font-family:system-ui;padding:20px;background:#0b1222;color:#e9f0ff}
input,button,select{padding:8px;border-radius:6px;border:1px solid #334; background:#14203a;color:#e9f0ff}
.card{background:#111a30;border:1px solid #27324a;padding:12px;border-radius:10px;margin:10px 0}
h2{margin-top:24px}</style></head><body>
<h1>Admin Panel</h1>

<div class="card">
  <h2>Token</h2>
  <input id="token" placeholder="x-admin-token" style="width:320px">
  <button onclick="loadReports()">Обновить жалобы</button>
  <button onclick="loadBans()">Обновить баны</button>
</div>

<div class="card">
  <h2>Создать бан</h2>
  <div>userId: <input id="uid" placeholder="u_xxx" style="width:240px"></div>
  <div>минут: <input id="mins" type="number" value="1440" style="width:120px"></div>
  <div>причина: <input id="reason" value="rule violation" style="width:240px"></div>
  <button onclick="doBan()">Ban</button>
</div>

<div class="card">
  <h2>Жалобы</h2>
  <div id="reports"></div>
</div>

<div class="card">
  <h2>Баны</h2>
  <div id="bans"></div>
</div>

<script>
async function loadReports(){
  const t = document.getElementById('token').value;
  const r = await fetch('/admin/reports',{headers:{'x-admin-token':t}});
  const j = await r.json();
  const box = document.getElementById('reports');
  box.innerHTML = '';
  if(!j.ok){ box.textContent='Ошибка'; return; }
  j.reports.sort((a,b)=>b.ts-a.ts).forEach(rep=>{
    const el = document.createElement('div');
    el.className='card';
    el.innerHTML = '<b>'+rep.id+'</b><br>от: '+rep.fromUser+'<br>на: <code>'+ (rep.againstUser||'—') +'</code><br>причина: '+rep.reason+'<br><small>'+new Date(rep.ts).toLocaleString()+'</small><br><br>'
      + '<button onclick="quickBan(\\''+(rep.againstUser||'')+'\\')">Бан на 24ч</button>';
    box.appendChild(el);
  });
}
async function loadBans(){
  const t = document.getElementById('token').value;
  const r = await fetch('/admin/bans',{headers:{'x-admin-token':t}});
  const j = await r.json();
  const box = document.getElementById('bans');
  box.innerHTML = '';
  if(!j.ok){ box.textContent='Ошибка'; return; }
  j.bans.forEach(b=>{
    const el = document.createElement('div');
    el.className='card';
    el.innerHTML = '<b>'+b.id+'</b><br>userId: '+(b.userId||'—')+'<br>ip: '+(b.ip||'—')+'<br>причина: '+b.reason+'<br>до: '+(b.until? new Date(b.until).toLocaleString():'∞')+'<br><br>'
      + '<button onclick="unban(\\''+b.id+'\\')">Снять бан</button>';
    box.appendChild(el);
  });
}
async function doBan(){
  const t = document.getElementById('token').value;
  const userId = document.getElementById('uid').value.trim();
  const minutes = +document.getElementById('mins').value || 60;
  const reason = document.getElementById('reason').value || 'rule violation';
  if(!userId){ alert('userId пуст'); return; }
  const r = await fetch('/admin/ban',{method:'POST',headers:{'x-admin-token':t,'Content-Type':'application/json'},body:JSON.stringify({userId,minutes,reason})});
  const j = await r.json();
  alert(JSON.stringify(j,null,2));
  loadBans();
}
async function unban(id){
  const t = document.getElementById('token').value;
  const r = await fetch('/admin/ban/'+id,{method:'DELETE',headers:{'x-admin-token':t}});
  const j = await r.json();
  alert(JSON.stringify(j,null,2));
  loadBans();
}
async function quickBan(uid){
  if(!uid){ alert('againstUser пуст у жалобы'); return; }
  document.getElementById('uid').value = uid;
  document.getElementById('mins').value = 1440;
  await doBan();
}
</script>
</body></html>`);
});


server.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000);
});

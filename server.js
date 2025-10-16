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
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "aliev";

// ====== Простая «БД» в файлах ======
const DB_DIR = __dirname;
const BANS_FILE = path.join(DB_DIR, "bans.json");
const REPORTS_FILE = path.join(DB_DIR, "reports.json");
const CHATS_FILE = path.join(DB_DIR, "chats.json"); // лог чатов

function readJSON(p, fallback = []) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error("readJSON error", p, e);
    return fallback;
  }
}
function writeJSON(p, data) {
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("writeJSON error", p, e);
  }
}

let bans = readJSON(BANS_FILE, []);       // [{id,userId?,ip?,reason,until}]
let reports = readJSON(REPORTS_FILE, []); // [{id,fromUser,againstUser,reason,chatId,ts}]
let chats = readJSON(CHATS_FILE, []);     // [{id, users:[u1,u2], startedAt, messages:[{from,text,ts}], closedAt?}]

// ====== Матчмейкинг ======
let waiting = []; // очередь ожидающих

// Возрастные диапазоны (18+)
const ALLOWED_RANGES = new Set(["18-22", "23-33", "34+"]);
function ageInRange(age, rangeKey) {
  const n = parseInt(age, 10);
  if (Number.isNaN(n)) return false;
  switch (rangeKey) {
    case "18-22": return n >= 18 && n <= 22;
    case "23-33": return n >= 23 && n <= 33;
    case "34+":   return n >= 34;
    default: return false;
  }
}

// Бан
function isBanActive(b) { return !b.until || Date.now() < b.until; }
function getActiveBanFor(userId, ip) {
  return bans.find(
    (b) =>
      isBanActive(b) &&
      ((userId && b.userId && b.userId === userId) ||
       (ip && b.ip && b.ip === ip))
  );
}
function banToPublic(b) {
  return { id: b.id, userId: b.userId || null, ip: b.ip || null, reason: b.reason || "", until: b.until || null };
}

// Совпадение фильтров
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

// ====== Chat helpers ======
function createChat(userA, userB) {
  const id = "c_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  const rec = {
    id,
    users: [userA || null, userB || null],
    startedAt: Date.now(),
    messages: [],
    closedAt: null,
  };
  chats.push(rec);
  writeJSON(CHATS_FILE, chats);
  return rec;
}
function appendChatMessage(chatId, fromUser, text) {
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) return;
  chat.messages.push({ from: fromUser || null, text: String(text || ""), ts: Date.now() });
  writeJSON(CHATS_FILE, chats);
}
function closeChat(chatId) {
  const chat = chats.find((c) => c.id === chatId);
  if (chat && !chat.closedAt) {
    chat.closedAt = Date.now();
    writeJSON(CHATS_FILE, chats);
  }
}
function findLatestChatBetween(u1, u2) {
  const pair = new Set([u1, u2]);
  const arr = chats
    .filter((c) => c.users.filter(Boolean).length === 2 && c.users.every((u) => pair.has(u)))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return arr[0] || null;
}

// ====== Socket.io ======
io.on("connection", (socket) => {
  const ip = socket.handshake.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || socket.handshake.address || "";
  const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId || null;

  socket.userId = userId;
  socket.userIp = ip;

  // проверка бана
  const ban = getActiveBanFor(userId, ip);
  if (ban) {
    socket.emit("banned", { reason: ban.reason || "Вы забанены", until: ban.until || null });
    setTimeout(() => socket.disconnect(true), 150);
    return;
  }

  // статистика стран
  socket.on("get_country_counts", (ack) => {
    try {
      const counts = getCountryCounts();
      if (typeof ack === "function") ack({ ok: true, counts });
    } catch (e) {
      if (typeof ack === "function") ack({ ok: false, error: String(e) });
    }
  });

  // поиск партнёра
  socket.on("find_partner", (data = {}) => {
    dropFromWaiting(socket);
    socket.partner = null;

    const myGender = (data.myGender === "male" || data.myGender === "female") ? data.myGender : "any";
    const myAge = parseInt(data.myAge, 10) || 18;
    const myCountry = (data.myCountry && String(data.myCountry)) || "any";

    const targetGender = (data.targetGender === "male" || data.targetGender === "female") ? data.targetGender : "any";
    let targetAges = Array.isArray(data.targetAges) ? data.targetAges : [];
    targetAges = targetAges.filter((k) => ALLOWED_RANGES.has(k));
    const targetCountry = data.targetCountry ? String(data.targetCountry) : "any";

    socket.profile = { myGender, myAge, myCountry, targetGender, targetAges, targetCountry };

    const idx = waiting.findIndex((s) => matches(socket.profile, s.profile));
    if (idx !== -1) {
      const partner = waiting[idx];
      waiting.splice(idx, 1);

      // создаём чат
      const chat = createChat(socket.userId || null, partner.userId || null);
      socket.chatId = chat.id;
      partner.chatId = chat.id;

      socket.partner = partner.id;
      partner.partner = socket.id;

      socket.emit("partner_found", {
        partnerId: partner.id,
        partnerUserId: partner.userId || null,
        chatId: chat.id,
      });
      partner.emit("partner_found", {
        partnerId: socket.id,
        partnerUserId: socket.userId || null,
        chatId: chat.id,
      });

      console.log("Paired:", socket.id, "<->", partner.id, "chat:", chat.id);
    } else {
      waiting.push(socket);
      console.log("Added to waiting:", socket.id, socket.profile);
    }
  });

  // сообщение
  socket.on("message", (msg) => {
    if (socket.partner) {
      io.to(socket.partner).emit("message", msg);
      // лог в чат
      if (socket.chatId) appendChatMessage(socket.chatId, socket.userId || null, msg);
    }
  });

  // индикатор набора
  socket.on("typing", (payload = {}) => {
    if (!socket.partner) return;
    io.to(socket.partner).emit("typing", { isTyping: !!payload.isTyping });
  });

  // завершить чат
  socket.on("finish_chat", () => {
    dropFromWaiting(socket);
    if (socket.chatId) closeChat(socket.chatId);
    if (socket.partner) {
      io.to(socket.partner).emit("partner_left");
      const partnerSocket = io.sockets.sockets.get(socket.partner);
      if (partnerSocket) partnerSocket.partner = null;
      socket.partner = null;
    }
  });

  // жалоба
  // payload: { againstUser?: string, reason: string, chatId?: string }
  socket.on("report_user", (payload = {}, ack) => {
    try {
      let againstUser = payload.againstUser || null;
      // если не прислали — берем у текущего партнёра
      if (!againstUser && socket.partner) {
        const partnerSocket = io.sockets.sockets.get(socket.partner);
        if (partnerSocket) againstUser = partnerSocket.userId || partnerSocket.id;
      }
      const chatId = payload.chatId || socket.chatId || null;

      const rec = {
        id: "r_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
        fromUser: socket.userId || socket.id,
        againstUser,
        reason: String(payload.reason || "unspecified"),
        chatId,
        ts: Date.now(),
      };
      reports.push(rec);
      writeJSON(REPORTS_FILE, reports);

      if (typeof ack === "function") ack({ ok: true });
    } catch (e) {
      if (typeof ack === "function") ack({ ok: false, error: String(e) });
    }
  });

  // отключение
  socket.on("disconnect", () => {
    dropFromWaiting(socket);
    if (socket.chatId) closeChat(socket.chatId);
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
  const list = [...reports].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  res.json({ ok: true, reports: list });
});

// Логи чата
app.get("/admin/chat", requireAdmin, (req, res) => {
  const { chatId, userA, userB } = req.query || {};
  let chat = null;

  if (chatId) {
    chat = chats.find((c) => c.id === chatId);
  } else if (userA && userB) {
    chat = findLatestChatBetween(String(userA), String(userB));
  }

  if (!chat) return res.status(404).json({ ok: false, error: "chat not found" });
  res.json({
    ok: true,
    chat: {
      id: chat.id,
      users: chat.users,
      startedAt: chat.startedAt,
      closedAt: chat.closedAt || null,
      messages: chat.messages,
    },
  });
});

// Создать бан
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

  // кикнем онлайн-подходящих
  for (const [, s] of io.sockets.sockets) {
    const hit =
      (ban.userId && s.userId && s.userId === ban.userId) ||
      (ban.ip && s.userIp && s.userIp === ban.ip);
    if (hit && isBanActive(ban)) {
      s.emit("banned", { reason, until });
      setTimeout(() => s.disconnect(true), 150);
    }
  }

  res.json({ ok: true, ban: banToPublic(ban) });
});

// Список банов
app.get("/admin/bans", requireAdmin, (req, res) => {
  res.json({ ok: true, bans: bans.map(banToPublic) });
});

// Снять бан по ID записи
app.delete("/admin/ban/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const i = bans.findIndex((b) => b.id === id);
  if (i === -1) return res.status(404).json({ ok: false, error: "not found" });
  const removed = bans.splice(i, 1)[0];
  writeJSON(BANS_FILE, bans);
  res.json({ ok: true, removed: banToPublic(removed) });
});

// Снять все баны пользователя и/или IP (НОВЫЙ, чтобы точно снялось)
app.post("/admin/unban", requireAdmin, (req, res) => {
  const { userId, ip } = req.body || {};
  if (!userId && !ip) return res.status(400).json({ ok: false, error: "userId or ip required" });
  const before = bans.length;
  bans = bans.filter((b) => !(
    (userId && b.userId === userId) ||
    (ip && b.ip === ip)
  ));
  writeJSON(BANS_FILE, bans);
  const removedCount = before - bans.length;
  res.json({ ok: true, removedCount });
});

// ====== Красивая, адаптивная админ-панель ======
app.get("/admin/panel", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Admin • Chat Roulette</title>
<style>
:root{
  --bg:#0b1222; --card:#101a33; --card2:#0f1730; --border:#26324b; --muted:#9fbfff;
  --txt:#e8f2ff; --accent:#6f3cff; --accent2:#33b9ff; --danger:#ff5d5d; --ok:#20c997;
  --shadow:0 10px 30px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif;background:linear-gradient(140deg,#0b1222,#0b1428 40%,#0a0f1f);color:var(--txt)}
.container{max-width:1100px;margin:30px auto;padding:0 18px}
.header{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap}
.title{font-weight:800;font-size:22px;letter-spacing:.3px}
.badge{font-size:12px;color:var(--bg);background:linear-gradient(90deg,var(--accent),var(--accent2));padding:6px 10px;border-radius:999px;font-weight:800}
.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:16px}
.card{background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow)}
.card .head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border);gap:8px;flex-wrap:wrap}
.card .head h3{margin:0;font-size:16px;font-weight:800}
.card .body{padding:14px 16px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input,button,select{border:1px solid var(--border);background:#111a30;color:var(--txt);border-radius:10px;padding:10px 12px;font-size:14px;outline:none}
button{cursor:pointer}
button.primary{background:linear-gradient(90deg,var(--accent),var(--accent2));border:none;color:#001220;font-weight:900}
button.line{background:transparent;border:1px solid var(--border)}
button.danger{background:var(--danger);border:none}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:10px}
.kpi{background:linear-gradient(180deg,#0e1832,#0d162c);border:1px solid var(--border);border-radius:12px;padding:12px}
.kpi .k{font-size:12px;color:var(--muted)}
.kpi .v{font-size:20px;font-weight:800;margin-top:6px}
.table{width:100%;border-collapse:separate;border-spacing:0 8px}
.table th{font-size:12px;color:var(--muted);text-align:left;padding:6px 8px}
.table td{background:#0f1934;border:1px solid var(--border);padding:10px;border-left:none;border-right:none;vertical-align:top}
.table tr td:first-child{border-top-left-radius:10px;border-bottom-left-radius:10px;border-left:1px solid var(--border)}
.table tr td:last-child{border-top-right-radius:10px;border-bottom-right-radius:10px;border-right:1px solid var(--border)}
.code{font-family:ui-monospace,Consolas,monospace;background:#0a1226;border:1px solid var(--border);padding:4px 6px;border-radius:6px}
.muted{color:var(--muted)}
.hr{height:1px;background:var(--border);margin:12px 0}
.actions{display:flex;gap:6px;flex-wrap:wrap}
.footer{opacity:.6;text-align:center;margin-top:14px}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;padding:18px}
.modal{max-width:900px;width:100%;background:linear-gradient(180deg,var(--card),var(--card2));border:1px solid var(--border);border-radius:14px}
.modal .head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border)}
.modal .head h3{margin:0;font-weight:800}
.modal .body{padding:14px}
.chatbox{height:420px;overflow:auto;border:1px solid var(--border);border-radius:10px;background:#0a1328;padding:10px}
.msg{padding:8px 10px;border-radius:8px;margin:6px 0;max-width:74%}
.me{background:#6f3cff;color:#fff;margin-left:auto}
.them{background:#243153}
.msg .ts{display:block;font-size:11px;opacity:.8;margin-top:4px}
a.link{color:#9fbfff;text-decoration:none;border-bottom:1px dashed #3f67ff}
.empty{padding:30px;text-align:center;color:#9fbfff}
@media (max-width: 820px){
  .container{margin:16px auto}
  .grid{grid-template-columns:1fr}
  .kpis{grid-template-columns:1fr}
  .table th:nth-child(4), .table td:nth-child(4){display:none} /* скрыть "Время" на узких экранах */
}
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">Админ-панель <span class="badge">moderation</span></div>
      <div class="row">
        <input id="token" placeholder="x-admin-token" style="min-width:220px">
        <button class="line" onclick="refreshAll()">Обновить всё</button>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="k">Всего жалоб</div><div class="v" id="kpi_reports">—</div></div>
      <div class="kpi"><div class="k">Активные баны</div><div class="v" id="kpi_bans">—</div></div>
      <div class="kpi"><div class="k">Всего чатов*</div><div class="v" id="kpi_chats">—</div></div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="head"><h3>Жалобы</h3>
          <div class="row">
            <button class="line" onclick="loadReports()">Обновить</button>
          </div>
        </div>
        <div class="body">
          <table class="table" style="width:100%">
            <thead>
              <tr>
                <th>От</th>
                <th>На</th>
                <th>Причина</th>
                <th>Время</th>
                <th>Чат</th>
                <th style="text-align:right">Действия</th>
              </tr>
            </thead>
            <tbody id="reports_tbody">
              <tr><td colspan="6" class="empty">Данных пока нет</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="head"><h3>Баны</h3>
          <div class="row">
            <button class="line" onclick="loadBans()">Обновить</button>
          </div>
        </div>
        <div class="body">
          <div class="row" style="margin-bottom:10px">
            <input id="uid" placeholder="userId (u_...)" style="flex:1;min-width:180px">
            <input id="mins" type="number" value="1440" style="width:110px">
            <input id="reason" value="rule violation" placeholder="причина" style="flex:1;min-width:160px">
            <button class="primary" onclick="doBan()">Забанить</button>
            <button class="line" onclick="unbanByUser()">Снять все баны пользователя</button>
          </div>
          <div id="bans_list"></div>
        </div>
      </div>
    </div>

    <div class="footer">© Admin • Chat Roulette</div>
  </div>

  <!-- Модалка чата -->
  <div id="modal-bg" class="modal-bg" onclick="closeModal(event)">
    <div class="modal" onclick="event.stopPropagation()">
      <div class="head">
        <h3 id="chat_title">История чата</h3>
        <button class="line" onclick="hideModal()">Закрыть</button>
      </div>
      <div class="body">
        <div class="chatbox" id="chat_box"><div class="empty">Нет сообщений</div></div>
      </div>
    </div>
  </div>

<script>
const qs = (s) => document.querySelector(s);
const el = (h, cls) => { const e = document.createElement(h); if(cls) e.className = cls; return e; };
function token(){ return qs('#token').value.trim(); }
function fmtTs(t){ try{ return new Date(t).toLocaleString('ru-RU'); }catch{ return '';} }

async function api(path, opt={}){
  const r = await fetch(path, { ...opt, headers: { ...(opt.headers||{}), 'x-admin-token': token() }});
  return r.json();
}

async function loadReports(){
  const data = await api('/admin/reports');
  const tbody = qs('#reports_tbody'); tbody.innerHTML = '';
  if(!data.ok || !data.reports.length){
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Жалоб нет</td></tr>';
    qs('#kpi_reports').textContent = data.ok ? data.reports.length : '—';
    return;
  }
  qs('#kpi_reports').textContent = data.reports.length;
  for(const rep of data.reports){
    const tr = el('tr');
    const tdFrom = el('td'); tdFrom.innerHTML = '<span class="code">'+(rep.fromUser||'—')+'</span>';
    const tdTo = el('td'); tdTo.innerHTML = rep.againstUser ? '<span class="code">'+rep.againstUser+'</span>' : '<span class="muted">—</span>';
    const tdReason = el('td'); tdReason.textContent = rep.reason || '—';
    const tdTime = el('td'); tdTime.innerHTML = '<span class="muted">'+fmtTs(rep.ts)+'</span>';
    const tdChat = el('td');
    if(rep.chatId){
      const a = el('a','link'); a.textContent = rep.chatId; a.href='#'; a.onclick=(e)=>{e.preventDefault(); openChat({chatId:rep.chatId, title: 'Чат '+rep.chatId});};
      tdChat.appendChild(a);
    } else {
      const btn = el('button','line'); btn.textContent='по паре'; btn.onclick=()=>openChat({userA:rep.fromUser, userB:rep.againstUser, title: 'Переписка пары'});
      tdChat.appendChild(btn);
    }
    const tdAct = el('td'); tdAct.style.textAlign='right';
    const actions = el('div','actions');

    const ban24 = el('button','line'); ban24.textContent='Бан 24ч';
    ban24.onclick = ()=>quickBan(rep.againstUser || '');
    const banCustom = el('button','line'); banCustom.textContent='Бан...';
    banCustom.onclick = async ()=>{
      const mins = prompt('Минуты бана', '1440');
      if(!mins) return;
      await doBan(rep.againstUser || '', parseInt(mins,10)||60);
    };
    const unbanAll = el('button','danger'); unbanAll.textContent='Снять все баны';
    unbanAll.onclick = ()=>unbanByUser(rep.againstUser||'');

    actions.appendChild(ban24);
    actions.appendChild(banCustom);
    actions.appendChild(unbanAll);
    tdAct.appendChild(actions);

    tr.appendChild(tdFrom);
    tr.appendChild(tdTo);
    tr.appendChild(tdReason);
    tr.appendChild(tdTime);
    tr.appendChild(tdChat);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }
}

async function openChat({chatId, userA, userB, title}){
  try{
    let url = '/admin/chat';
    if(chatId){ url += '?chatId='+encodeURIComponent(chatId); }
    else if(userA && userB){ url += '?userA='+encodeURIComponent(userA)+'&userB='+encodeURIComponent(userB); }
    else { alert('Недостаточно данных для загрузки чата'); return; }

    const data = await api(url);
    if(!data.ok){ alert('Чат не найден'); return; }

    qs('#chat_title').textContent = title || ('Чат '+data.chat.id);
    const box = qs('#chat_box'); box.innerHTML = '';

    if(!data.chat.messages || !data.chat.messages.length){
      box.innerHTML = '<div class="empty">Сообщений нет</div>';
    } else {
      for(const m of data.chat.messages){
        const wrap = el('div','msg '+(m.from === data.chat.users[0] ? 'me':'them'));
        wrap.textContent = m.text;
        const ts = el('span','ts'); ts.textContent = fmtTs(m.ts);
        wrap.appendChild(ts);
        box.appendChild(wrap);
      }
      box.scrollTop = box.scrollHeight;
    }
    showModal();
  }catch(e){ console.error(e); alert('Ошибка загрузки чата'); }
}

function showModal(){ qs('#modal-bg').style.display='flex'; }
function hideModal(){ qs('#modal-bg').style.display='none'; }
function closeModal(e){ if(e.target.id==='modal-bg') hideModal(); }

async function doBan(userId, minutes){
  userId = userId || qs('#uid').value.trim();
  minutes = minutes || parseInt(qs('#mins').value,10) || 60;
  const reason = qs('#reason').value || 'rule violation';
  if(!userId){ alert('userId пуст'); return; }
  const r = await api('/admin/ban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,minutes,reason})});
  if(!r.ok) { alert('Ошибка: '+(r.error||'')); return; }
  alert('Забанен до: '+(r.ban.until? new Date(r.ban.until).toLocaleString('ru-RU') : '∞'));
  await loadBans();
}
async function quickBan(uid){ if(!uid){ alert('Нет againstUser'); return; } qs('#uid').value = uid; qs('#mins').value = 1440; await doBan(uid, 1440); }

async function loadBans(){
  const data = await api('/admin/bans');
  const box = qs('#bans_list'); box.innerHTML='';
  if(!data.ok || !data.bans.length){ box.innerHTML='<div class="empty">Банов нет</div>'; qs('#kpi_bans').textContent='0'; return; }
  qs('#kpi_bans').textContent = data.bans.filter(b=>!b.until || Date.now()<b.until).length;
  for(const b of data.bans){
    const card = el('div','card'); card.style.margin='8px 0';
    const body = el('div','body');
    body.innerHTML = '<div class="row" style="justify-content:space-between;gap:10px">'
      + '<div><b>'+b.id+'</b><div class="muted">userId: '+(b.userId||'—')+' | ip: '+(b.ip||'—')+'</div><div class="muted">причина: '+(b.reason||'—')+'</div></div>'
      + '<div class="row" style="min-width:220px;justify-content:flex-end"><span class="muted">до: '+(b.until? new Date(b.until).toLocaleString('ru-RU') : '∞')+'</span>'
      + '<button class="danger" onclick="unbanId(\\''+b.id+'\\')" style="margin-left:10px">Снять ID</button>'
      + (b.userId? '<button class="line" onclick="unbanByUser(\\''+b.userId+'\\')" style="margin-left:6px">Снять все по userId</button>' : '')
      + '</div></div>';
    card.appendChild(body);
    box.appendChild(card);
  }
}

async function unbanId(id){
  const ok = confirm('Снять бан '+id+'?');
  if(!ok) return;
  const r = await api('/admin/ban/'+id,{method:'DELETE'});
  if(!r.ok){ alert('Ошибка'); return; }
  await loadBans();
}
async function unbanByUser(uid){
  uid = uid || qs('#uid').value.trim();
  if(!uid){ alert('Введите userId'); return; }
  const r = await api('/admin/unban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:uid})});
  if(!r.ok){ alert('Ошибка'); return; }
  alert('Снято записей: '+r.removedCount);
  await loadBans();
}

async function loadKpis(){
  try{
    const r1 = await api('/admin/reports');
    qs('#kpi_reports').textContent = r1.ok ? r1.reports.length : '—';
  }catch{}
  try{
    const r2 = await api('/admin/bans');
    qs('#kpi_bans').textContent = r2.ok ? r2.bans.filter(b=>!b.until || Date.now()<b.until).length : '—';
  }catch{}
  try{
    const r1 = await api('/admin/reports');
    const uniq = new Set((r1.reports||[]).map(x=>x.chatId).filter(Boolean));
    qs('#kpi_chats').textContent = uniq.size || '—';
  }catch{}
}

async function refreshAll(){
  await Promise.all([loadReports(), loadBans()]);
  await loadKpis();
}

// автозагрузка
refreshAll();
</script>
</body>
</html>`);
});

// ====== Запуск ======
server.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000);
});

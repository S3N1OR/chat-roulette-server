const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Очередь ожидания (сокеты)
let waiting = [];

// Допустимые возрастные диапазоны (18+)
const ALLOWED_RANGES = new Set(["18-22", "23-33", "34+"]);

// Попадание возраста в диапазон (18+)
function ageInRange(age, rangeKey) {
  const n = parseInt(age, 10);
  if (Number.isNaN(n)) return false;

  switch (rangeKey) {
    case "18-22":
      return n >= 18 && n <= 22;
    case "23-33":
      return n >= 23 && n <= 33;
    case "34+":
      return n >= 34;
    default:
      return false;
  }
}

// Совместимость по полу, возрасту и стране (обоюдно)
function matches(me, other) {
  if (!other) return false;

  // пол
  const genderOk =
    me.targetGender === "any" || me.targetGender === other.myGender;
  const partnerGenderOk =
    other.targetGender === "any" || other.targetGender === me.myGender;

  // возраст
  const ageOk =
    !me.targetAges.length || me.targetAges.some((r) => ageInRange(other.myAge, r));
  const partnerAgeOk =
    !other.targetAges.length || other.targetAges.some((r) => ageInRange(me.myAge, r));

  // страна
  const countryOk =
    !me.targetCountry || me.targetCountry === "any" || me.targetCountry === other.myCountry;
  const partnerCountryOk =
    !other.targetCountry || other.targetCountry === "any" || other.targetCountry === me.myCountry;

  return genderOk && partnerGenderOk && ageOk && partnerAgeOk && countryOk && partnerCountryOk;
}

// Удалить сокет из очереди ожидания (если там есть)
function dropFromWaiting(sock) {
  const idx = waiting.findIndex((s) => s.id === sock.id);
  if (idx !== -1) waiting.splice(idx, 1);
}

// Посчитать количество ожидающих по странам
function getCountryCounts() {
  const counts = {};
  for (const s of waiting) {
    const c = (s.profile?.myCountry || "any");
    if (!counts[c]) counts[c] = 0;
    counts[c] += 1;
  }
  return counts;
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Клиент запрашивает статистику стран (ack callback)
  socket.on("get_country_counts", (ack) => {
    try {
      const counts = getCountryCounts();
      if (typeof ack === "function") ack({ ok: true, counts });
    } catch (e) {
      if (typeof ack === "function") ack({ ok: false, error: String(e) });
    }
  });

  socket.on("find_partner", (data = {}) => {
    // Чистим возможную старую запись ожидания
    dropFromWaiting(socket);
    socket.partner = null;

    // Нормализация профиля
    const myGender =
      data.myGender === "male" || data.myGender === "female" ? data.myGender : "any";
    const myAge = parseInt(data.myAge, 10) || 18; // 18+ по умолчанию
    const myCountry = (data.myCountry && String(data.myCountry)) || "any";

    // Нормализация фильтров
    const targetGender =
      data.targetGender === "male" || data.targetGender === "female" ? data.targetGender : "any";

    let targetAges = Array.isArray(data.targetAges) ? data.targetAges : [];
    targetAges = targetAges.filter((k) => ALLOWED_RANGES.has(k));

    const targetCountry =
      data.targetCountry && String(data.targetCountry).length ? String(data.targetCountry) : "any";

    socket.profile = { myGender, myAge, myCountry, targetGender, targetAges, targetCountry };

    // Пытаемся найти пару
    const partnerIndex = waiting.findIndex((s) => matches(socket.profile, s.profile));
    if (partnerIndex !== -1) {
      const partner = waiting[partnerIndex];
      waiting.splice(partnerIndex, 1);

      socket.partner = partner.id;
      partner.partner = socket.id;

      socket.emit("partner_found", { partnerId: partner.id });
      partner.emit("partner_found", { partnerId: socket.id });

      console.log("Paired:", socket.id, "<->", partner.id, {
        me: socket.profile,
        other: partner.profile,
      });
    } else {
      waiting.push(socket);
      console.log("Added to waiting:", socket.id, socket.profile);
    }
  });

  socket.on("message", (msg) => {
    if (socket.partner) io.to(socket.partner).emit("message", msg);
  });

  socket.on("finish_chat", () => {
    dropFromWaiting(socket);
    if (socket.partner) {
      io.to(socket.partner).emit("partner_left");
      const partnerSocket = io.sockets.sockets.get(socket.partner);
      if (partnerSocket) partnerSocket.partner = null;
      socket.partner = null;
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    dropFromWaiting(socket);
    if (socket.partner) {
      io.to(socket.partner).emit("partner_left");
      const partnerSocket = io.sockets.sockets.get(socket.partner);
      if (partnerSocket) partnerSocket.partner = null;
      socket.partner = null;
    }
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000);
});

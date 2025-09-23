const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// Очередь ожидания
let waiting = [];

// Допустимые ключи диапазонов
const ALLOWED_RANGE_KEYS = new Set(["<18", "18-22", "23-33", "34+"]);

// Возраст попадает в диапазон?
function ageInRange(age, rangeKey) {
  const n = parseInt(age, 10);
  if (Number.isNaN(n)) return false;

  switch (rangeKey) {
    case "<18":
      return n < 18;
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

// Нормализация профиля, пришедшего от клиента
function normalizeProfile(data = {}) {
  const g = (data.myGender || "any").toString();
  const tg = (data.targetGender || "any").toString();
  const myAgeNum = parseInt(data.myAge, 10);
  const myAge = Number.isFinite(myAgeNum) ? myAgeNum : 0;

  // Поддержка старых клиентов: targetAge (один ключ) -> массив
  let rawRanges = Array.isArray(data.targetAges)
    ? data.targetAges
    : (data.targetAge ? [data.targetAge] : []);

  // Строка с JSON? Попробуем распарсить (на всякий случай)
  if (!Array.isArray(rawRanges) && typeof rawRanges === "string") {
    try {
      const parsed = JSON.parse(rawRanges);
      if (Array.isArray(parsed)) rawRanges = parsed;
    } catch {}
  }

  // Фильтруем только разрешённые ключи
  const targetAges = (rawRanges || [])
    .map(String)
    .filter((k) => ALLOWED_RANGE_KEYS.has(k));

  return {
    myGender: g === "male" || g === "female" ? g : "any",
    myAge,
    targetGender: tg === "male" || tg === "female" ? tg : "any",
    targetAges, // массив ключей диапазонов
  };
}

// Проверка совместимости двух сторон (оба фильтруют друг друга)
function matches(me, other) {
  if (!me || !other) return false;

  // Пол
  const meGenderOk =
    me.targetGender === "any" || me.targetGender === other.myGender;
  const otherGenderOk =
    other.targetGender === "any" || other.targetGender === me.myGender;

  // Возраст (если массив пуст — фильтр не задан)
  const meAgeOk =
    me.targetAges.length === 0 ||
    me.targetAges.some((rk) => ageInRange(other.myAge, rk));

  const otherAgeOk =
    other.targetAges.length === 0 ||
    other.targetAges.some((rk) => ageInRange(me.myAge, rk));

  return meGenderOk && otherGenderOk && meAgeOk && otherAgeOk;
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("find_partner", (payload) => {
    // Нормализуем профиль
    socket.profile = normalizeProfile(payload);
    console.log("Searching:", socket.id, socket.profile);

    // Из очереди убираем все старые вхождения этого сокета (на всякий)
    waiting = waiting.filter((s) => s.id !== socket.id && s.connected);

    // Ищем совместимого
    const idx = waiting.findIndex(
      (s) => s && s.profile && matches(socket.profile, s.profile)
    );

    if (idx !== -1) {
      const partner = waiting[idx];
      waiting.splice(idx, 1);

      socket.partner = partner.id;
      partner.partner = socket.id;

      socket.emit("partner_found", { partnerId: partner.id });
      partner.emit("partner_found", { partnerId: socket.id });

      console.log("Paired:", socket.id, "<->", partner.id);
    } else {
      // Никого подходящего — добавляем в очередь
      waiting.push(socket);
      console.log("Added to waiting:", socket.id);
    }
  });

  socket.on("message", (msg) => {
    if (socket.partner) {
      io.to(socket.partner).emit("message", msg);
    }
  });

  socket.on("finish_chat", () => {
    // Уведомляем партнёра и разрываем связь
    if (socket.partner) {
      const partnerId = socket.partner;
      socket.partner = null;

      io.to(partnerId).emit("partner_left");

      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) partnerSocket.partner = null;

      console.log("Finish chat:", socket.id, "-> notify", partnerId);
    } else {
      // Если был в ожидании — убираем из очереди
      waiting = waiting.filter((s) => s.id !== socket.id);
      console.log("Finish while waiting:", socket.id);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    // Удаляем из очереди
    waiting = waiting.filter((s) => s.id !== socket.id);

    if (socket.partner) {
      const partnerId = socket.partner;
      io.to(partnerId).emit("partner_left");
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) partnerSocket.partner = null;
      socket.partner = null;

      console.log("Disconnected -> notify partner:", partnerId);
    }
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000);
});

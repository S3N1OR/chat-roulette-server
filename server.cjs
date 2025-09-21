// server.cjs  (CommonJS)
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.get("/", (_req, res) => res.send("OK")); // healthcheck для Render

// ====== состояние матчера ======
/** socket.id -> { gender: 'male'|'female', age: number } */
const profiles = new Map();
/** очередь ожидания: [{ id, filters: {gender:'any'|'male'|'female', ageMin, ageMax} }] */
const waiting = [];
/** roomId -> { a: socketId, b: socketId } */
const rooms = new Map();

// DEBUG эндпоинт
app.get("/debug", (_req, res) => {
  res.json({
    profiles: [...profiles.entries()].map(([id, p]) => ({ id, ...p })),
    waiting: waiting.map((w) => ({ id: w.id, filters: w.filters })),
    rooms: [...rooms.entries()].map(([roomId, { a, b }]) => ({ roomId, a, b })),
  });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const log = (...args) => console.log(new Date().toISOString(), ...args);

function normalizeFilters(filters) {
  const f = {
    gender: ["any", "male", "female"].includes(filters?.gender) ? filters.gender : "any",
    ageMin: Math.max(18, Number(filters?.ageMin) || 18),
    ageMax: Math.min(99, Number(filters?.ageMax) || 99),
  };
  if (f.ageMax < f.ageMin) [f.ageMin, f.ageMax] = [f.ageMax, f.ageMin];
  return f;
}

function passFilter(targetProfile, filters) {
  if (!targetProfile) return false;
  const { gender, ageMin = 18, ageMax = 99 } = filters || {};
  if (gender && gender !== "any" && targetProfile.gender !== gender) return false;
  const a = Number(targetProfile.age || 0);
  return a >= Number(ageMin) && a <= Number(ageMax);
}

function removeFromWaiting(id) {
  const idx = waiting.findIndex((w) => w.id === id);
  if (idx !== -1) waiting.splice(idx, 1);
}

/** Пытаемся сматчить meId; при успехе удаляем ОБОИХ из очереди */
function tryMatch(meId) {
  const meWait = waiting.find((w) => w.id === meId);
  if (!meWait) return null;

  const myProfile = profiles.get(meId);
  const idx = waiting.findIndex((w) => {
    if (w.id === meId) return false;
    const hisProfile = profiles.get(w.id);
    return passFilter(hisProfile, meWait.filters) && passFilter(myProfile, w.filters);
  });
  if (idx === -1) return null;

  const pair = waiting[idx].id;

  // удалить ОБОИХ из очереди
  removeFromWaiting(meId);
  removeFromWaiting(pair);

  const roomId = `${meId}__${pair}__${Date.now()}`;
  rooms.set(roomId, { a: meId, b: pair });

  const meProfileSafe = profiles.get(meId) || null;
  const peerProfileSafe = profiles.get(pair) || null;

  log("[MATCH]", { roomId, a: meId, b: pair, aProfile: meProfileSafe, bProfile: peerProfileSafe });

  io.to(meId).emit("matchFound", { roomId, peerProfile: peerProfileSafe });
  io.to(pair).emit("matchFound", { roomId, peerProfile: meProfileSafe });
  return roomId;
}

io.on("connection", (socket) => {
  log("[CONNECT]", socket.id);

  const emitQueue = () => socket.emit("searchStatus", { queue: waiting.length });

  socket.on("setProfile", (profile) => {
    const norm = {
      gender: profile?.gender === "female" ? "female" : "male",
      age: Math.max(18, Math.min(99, Number(profile?.age) || 18)),
    };
    profiles.set(socket.id, norm);
    log("[PROFILE]", socket.id, norm);

    const roomId = tryMatch(socket.id); // если уже в очереди — попробуем сматчить
    if (!roomId) emitQueue();
  });

  socket.on("startSearch", ({ filters } = {}) => {
    const f = normalizeFilters(filters);
    const existing = waiting.find((w) => w.id === socket.id);
    if (existing) existing.filters = f;
    else waiting.push({ id: socket.id, filters: f });

    log("[SEARCH start]", socket.id, f, "queue:", waiting.length);

    const roomId = tryMatch(socket.id);
    if (!roomId) emitQueue();
  });

  socket.on("cancelSearch", () => {
    removeFromWaiting(socket.id);
    log("[SEARCH cancel]", socket.id, "queue:", waiting.length);
    emitQueue();
  });

  socket.on("joinRoom", ({ roomId }) => {
    if (!rooms.has(roomId)) {
      log("[JOIN fail] no room", roomId, "by", socket.id);
      return;
    }
    socket.join(roomId);
    log("[JOIN ok]", roomId, "by", socket.id);
  });

  socket.on("msg", ({ roomId, text }) => {
    if (!rooms.has(roomId) || typeof text !== "string") return;
    io.to(roomId).emit("msg", { text });
  });

  socket.on("endChat", ({ roomId }) => {
    const r = rooms.get(roomId);
    if (!r) return;
    io.to(roomId).emit("peerEnded");
    io.to(roomId).emit("roomClosed");
    rooms.delete(roomId);
    log("[END chat]", roomId);
  });

  socket.on("leaveRoom", ({ roomId }) => {
    socket.leave(roomId);
    log("[LEAVE]", roomId, "by", socket.id);
  });

  socket.on("disconnect", () => {
    removeFromWaiting(socket.id);
    for (const [roomId, pair] of rooms.entries()) {
      if (pair.a === socket.id || pair.b === socket.id) {
        io.to(roomId).emit("peerEnded");
        io.to(roomId).emit("roomClosed");
        rooms.delete(roomId);
        log("[DISCONNECT closed room]", roomId, "by", socket.id);
      }
    }
    profiles.delete(socket.id);
    log("[DISCONNECT]", socket.id, "queue:", waiting.length);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  log("Server listening on", PORT);
});

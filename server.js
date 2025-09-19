// server/index.js
import http from "http";
import { Server } from "socket.io";

const server = http.createServer();
const io = new Server(server, { cors: { origin: "*" } });

// Профили и очередь
const profiles = new Map();     // socket.id -> { gender, age, country }
const waiting = [];             // [{ id, filters }]

// Пары и комнаты
const pairs = new Map();        // socket.id -> { peerId, roomId }
const roomsMembers = new Map(); // roomId -> Set<socketId>

function passFilter(targetProfile, filters) {
  if (!targetProfile) return false;
  if (filters.gender && filters.gender !== "any") {
    if (targetProfile.gender !== filters.gender) return false;
  }
  const aMin = Number(filters.ageMin ?? 18);
  const aMax = Number(filters.ageMax ?? 99);
  if (targetProfile.age < aMin || targetProfile.age > aMax) return false;

  if (typeof filters.country === "string" && filters.country.length > 0) {
    if ((targetProfile.country || "") !== filters.country) return false;
  }
  return true;
}

function makeRoomId(a, b) {
  return [a, b].sort().join("#");
}

function leaveQueue(socketId) {
  const idx = waiting.findIndex((w) => w.id === socketId);
  if (idx >= 0) waiting.splice(idx, 1);
}

function breakPair(socketId, reason = "peer_disconnected") {
  const pair = pairs.get(socketId);
  if (!pair) return;
  const { peerId, roomId } = pair;

  // уведомим второго
  if (io.sockets.sockets.get(peerId)) {
    io.to(peerId).emit(reason);
    // выкинем из его пары
    pairs.delete(peerId);
    try {
      const sPeer = io.sockets.sockets.get(peerId);
      sPeer && sPeer.leave(roomId);
    } catch (_) {}
  }

  // почистим текущего
  pairs.delete(socketId);

  // выйти из комнаты
  try {
    const s = io.sockets.sockets.get(socketId);
    s && s.leave(roomId);
  } catch (_) {}

  // почистить комнату
  const set = roomsMembers.get(roomId);
  if (set) {
    set.delete(socketId);
    set.delete(peerId);
    if (set.size === 0) roomsMembers.delete(roomId);
  }
}

io.on("connection", (socket) => {
  // Профиль
  socket.on("update_profile", (p) => {
    const profile = {
      gender: p?.gender ?? "any",
      age: Number(p?.age ?? 18),
      country: (p?.country ?? "").toUpperCase(),
    };
    profiles.set(socket.id, profile);
  });

  // Поиск партнёра
  socket.on("find_partner", (filters) => {
    // если вдруг уже в паре — разорвём
    if (pairs.has(socket.id)) {
      breakPair(socket.id, "chat_finished");
    }

    const myFilters = {
      gender: filters?.gender ?? "any",
      ageMin: Number(filters?.ageMin ?? 18),
      ageMax: Number(filters?.ageMax ?? 99),
      country: (filters?.country ?? "").toUpperCase(),
    };
    const myProfile = profiles.get(socket.id) || {
      gender: "any",
      age: 18,
      country: "",
    };

    // попробуем найти взаимный матч
    for (let i = 0; i < waiting.length; i++) {
      const candidate = waiting[i];
      const candProfile = profiles.get(candidate.id);
      if (!candProfile) {
        waiting.splice(i, 1);
        i--;
        continue;
      }

      const a = passFilter(candProfile, myFilters);
      const b = passFilter(myProfile, candidate.filters);
      if (a && b) {
        waiting.splice(i, 1);

        // создаём комнату
        const roomId = makeRoomId(socket.id, candidate.id);
        const set = roomsMembers.get(roomId) || new Set();
        roomsMembers.set(roomId, set);

        try {
          socket.join(roomId);
          const peerSocket = io.sockets.sockets.get(candidate.id);
          peerSocket && peerSocket.join(roomId);
        } catch (_) {}

        set.add(socket.id);
        set.add(candidate.id);

        // сохраняем пару
        pairs.set(socket.id, { peerId: candidate.id, roomId });
        pairs.set(candidate.id, { peerId: socket.id, roomId });

        // сообщаем обоим (передаём и roomId, и peerId)
        io.to(candidate.id).emit("partner_found", {
          roomId,
          peerId: socket.id,
        });
        io.to(socket.id).emit("partner_found", {
          roomId,
          peerId: candidate.id,
        });
        return;
      }
    }

    // не нашли – встали/обновили в очереди
    const idx = waiting.findIndex((w) => w.id === socket.id);
    const entry = { id: socket.id, filters: myFilters };
    if (idx >= 0) waiting[idx] = entry;
    else waiting.push(entry);
  });

  // Пришло сообщение из чата
  socket.on("chat_message", (payload) => {
    const pair = pairs.get(socket.id);
    if (!pair) return;
    const { roomId, peerId } = pair;
    const text = String(payload?.text ?? "").slice(0, 2000);
    const ts = Date.now();

    // передаём второму участнику
    io.to(peerId).emit("chat_message", {
      from: socket.id,
      text,
      ts,
      roomId,
    });
  });

  // Завершение чата по кнопке
  socket.on("finish_chat", () => {
    leaveQueue(socket.id);
    breakPair(socket.id, "chat_finished");
  });

  // Отключение
  socket.on("disconnect", () => {
    leaveQueue(socket.id);
    breakPair(socket.id, "peer_disconnected");
    profiles.delete(socket.id);
  });
});

server.listen(process.env.PORT || 3001, () => {
  console.log("Matcher listening");
});

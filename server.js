const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// очередь ожидания
let waiting = [];

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // 🔹 Поиск партнёра с учётом фильтров
  socket.on("find_partner", (data) => {
    const { myGender, myAge, targetGender, targetAge } = data;
    socket.profile = { myGender, myAge, targetGender, targetAge };

    console.log("Searching:", socket.id, socket.profile);

    // найти совместимого из очереди
    let partnerIndex = waiting.findIndex((s) => {
      if (!s.profile) return false;
      const p = s.profile;

      // условия совпадения: я удовлетворяю фильтры собеседника и он удовлетворяет мои
      const matchForMe =
        (p.myGender === targetGender || targetGender === "any") &&
        (targetGender === "any" || true) &&
        (targetAge === "any" || p.myAge === targetAge);

      const matchForPartner =
        (myGender === p.targetGender || p.targetGender === "any") &&
        (p.targetAge === "any" || myAge === p.targetAge);

      return matchForMe && matchForPartner;
    });

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
      console.log("Added to waiting:", socket.id);
    }
  });

  // Сообщения
  socket.on("message", (msg) => {
    if (socket.partner) {
      io.to(socket.partner).emit("message", msg);
    }
  });

  // Завершить чат
  socket.on("finish_chat", () => {
    if (socket.partner) {
      io.to(socket.partner).emit("partner_left");
      const partnerSocket = io.sockets.sockets.get(socket.partner);
      if (partnerSocket) partnerSocket.partner = null;
      socket.partner = null;
    } else {
      waiting = waiting.filter((s) => s.id !== socket.id);
    }
  });

  // Отключение
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    waiting = waiting.filter((s) => s.id !== socket.id);
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

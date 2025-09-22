// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

let waiting = null;

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // КОМАНДА: find_partner
  socket.on("find_partner", () => {
    // Если уже есть ожидающий и это не тот же самый сокет — свяжем
    if (waiting && waiting.id !== socket.id) {
      const partner = waiting;
      waiting = null;

      socket.partner = partner.id;
      partner.partner = socket.id;

      socket.emit("partner_found", { partnerId: partner.id });
      partner.emit("partner_found", { partnerId: socket.id });

      console.log("Paired:", socket.id, "<->", partner.id);
    } else {
      // Если waiting === socket (кейс, когда тот же клиент повторно послал find), игнорируем и оставляем его ждать
      // Если waiting == null — назначаем
      if (!waiting) {
        waiting = socket;
        console.log("Waiting set to:", socket.id);
      } else if (waiting.id === socket.id) {
        // уже ждёт - ничего не делаем
        console.log("Socket already waiting:", socket.id);
      }
    }
  });

  // Отправка сообщения партнеру
  socket.on("message", (msg) => {
    if (socket.partner) {
      io.to(socket.partner).emit("message", msg);
    }
  });

  // Пользователь нажал "Завершить" (чистый выход из чата)
  socket.on("finish_chat", () => {
    if (socket.partner) {
      // уведомляем партнёра
      io.to(socket.partner).emit("partner_left");
      // снять связь
      const partnerSocket = io.sockets.sockets.get(socket.partner);
      if (partnerSocket) partnerSocket.partner = null;
      socket.partner = null;
      console.log("Finish chat: notified partner of", socket.id);
    } else {
      // если просто был в ожидании, переставляем waiting
      if (waiting && waiting.id === socket.id) {
        waiting = null;
        console.log("Finish chat while waiting:", socket.id);
      }
    }
  });

  // Отключение сокета
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    if (waiting && waiting.id === socket.id) {
      waiting = null;
    }
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

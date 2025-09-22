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

// 🔹 функция: проверка попадания возраста в диапазон
function ageInRange(age, rangeKey) {
  const n = parseInt(age, 10);
  if (isNaN(n)) return false;

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

// 🔹 проверка совместимости по фильтрам
function matches(me, other) {
  if (!other) return false;

  // пол
  const genderOk = me.targetGender === "any" || me.targetGender === other.myGender;
  const partnerGenderOk = other.targetGender === "any" || other.targetGender === me.myGender;

  // возраст
  const ageOk =
    !me.targetAges?.length ||
    me.targetAges.some((r) => ageInRange(other.myAge, r));

  const partnerAgeOk =
    !other.targetAges?.length ||
    other.targetAges.some((r) => ageInRange(me.myAge, r));

  return genderOk && partnerGenderOk && ageOk && partnerAgeOk;
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("find_partner", (data) => {
    const { myGender, myAge, targetGender, targetAges } = data;
    socket.profile = {
      myGender,
      myAge: parseInt(myAge, 10) || 0, // 🔹 приводим к числу
      targetGender,
      targetAges: Array.isArray(targetAges) ? targetAges : [],
    };

    console.log("Searching:", socket.id, socket.profile);

    // найти совместимого собеседника
    let partnerIndex = waiting.findIndex((s) =>
      matches(socket.profile, s.profile)
    );

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

  socket.on("message", (msg) => {
    if (socket.partner) {
      io.to(socket.partner).emit("message", msg);
    }
  });

  socket.on("finish_chat", () => {
    if (socket.partner) {
      io.to(socket.partner).emit("partner_left"); // 🔹 уведомляем
      const partnerSocket = io.sockets.sockets.get(socket.partner);
      if (partnerSocket) partnerSocket.partner = null;
      socket.partner = null;
    } else {
      waiting = waiting.filter((s) => s.id !== socket.id);
    }
  });

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

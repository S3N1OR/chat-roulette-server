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

  socket.on("find_partner", () => {
    if (waiting) {
      const partner = waiting;
      waiting = null;

      socket.partner = partner.id;
      partner.partner = socket.id;

      socket.emit("partner_found", { partnerId: partner.id });
      partner.emit("partner_found", { partnerId: socket.id });
    } else {
      waiting = socket;
    }
  });

  socket.on("message", (msg) => {
    if (socket.partner) {
      io.to(socket.partner).emit("message", msg);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    if (waiting && waiting.id === socket.id) {
      waiting = null;
    }
    if (socket.partner) {
      io.to(socket.partner).emit("partner_left");
    }
  });
});

server.listen(3000, () => {
  console.log("Server running on port 3000");
});

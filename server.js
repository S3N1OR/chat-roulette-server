// server/index.js
import http from "http";
import { Server } from "socket.io";

const server = http.createServer();
const io = new Server(server, { cors: { origin: "*" } });

const profiles = new Map(); // socket.id -> { gender, age, country }
const waiting = [];         // очередь: [{ id, filters }]

function passFilter(targetProfile, filters) {
  if (!targetProfile) return false;
  // пол
  if (filters.gender && filters.gender !== "any") {
    if (targetProfile.gender !== filters.gender) return false;
  }
  // возраст
  const aMin = Number(filters.ageMin ?? 18);
  const aMax = Number(filters.ageMax ?? 99);
  if (targetProfile.age < aMin || targetProfile.age > aMax) return false;
  // страна
  if (typeof filters.country === "string" && filters.country.length > 0) {
    if ((targetProfile.country || "") !== filters.country) return false;
  }
  return true;
}

io.on("connection", (socket) => {
  socket.on("update_profile", (p) => {
    // нормализуем
    const profile = {
      gender: p?.gender ?? "any",
      age: Number(p?.age ?? 18),
      country: (p?.country ?? "").toUpperCase(),
    };
    profiles.set(socket.id, profile);
  });

  socket.on("find_partner", (filters) => {
    const myFilters = {
      gender: filters?.gender ?? "any",
      ageMin: Number(filters?.ageMin ?? 18),
      ageMax: Number(filters?.ageMax ?? 99),
      country: (filters?.country ?? "").toUpperCase(),
    };
    // пытаемся найти взаимный матч
    const myProfile = profiles.get(socket.id) || { gender: "any", age: 18, country: "" };

    for (let i = 0; i < waiting.length; i++) {
      const candidate = waiting[i];
      const candProfile = profiles.get(candidate.id);
      if (!candProfile) { waiting.splice(i,1); i--; continue; }

      const a = passFilter(candProfile, myFilters);        // кандидат удовлетворяет моим фильтрам
      const b = passFilter(myProfile, candidate.filters);  // я удовлетворяю его фильтрам
      if (a && b) {
        waiting.splice(i, 1);
        io.to(candidate.id).emit("partner_found", { partnerId: candidate.id });
        io.to(socket.id).emit("partner_found", { partnerId: socket.id });
        return;
      }
    }

    // не нашли — встаём в очередь
    // заменяем прежнюю заявку, если была
    const idx = waiting.findIndex(w => w.id === socket.id);
    const entry = { id: socket.id, filters: myFilters };
    if (idx >= 0) waiting[idx] = entry; else waiting.push(entry);
  });

  socket.on("finish_chat", () => {
    const idx = waiting.findIndex(w => w.id === socket.id);
    if (idx >= 0) waiting.splice(idx, 1);
  });

  socket.on("disconnect", () => {
    profiles.delete(socket.id);
    const idx = waiting.findIndex(w => w.id === socket.id);
    if (idx >= 0) waiting.splice(idx, 1);
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log("Matcher listening");
});

import { Server } from "socket.io";

const port = process.env.PORT || 3000;

const io = new Server(port, {
  cors: {
    origin: "*",
  },
});

const rooms = new Map();

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("join-room", ({ roomId, username }) => {
    if (!roomId || !username) return;

    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        players: [],
        started: false,
      });
    }

    const room = rooms.get(roomId);

    const player = {
      id: socket.id,
      username,
    };

    room.players.push(player);

    socket.data.roomId = roomId;
    socket.data.username = username;

    io.to(roomId).emit("room-state", room);

    console.log(`${username} joined room ${roomId}`);
  });

  socket.on("start-game", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.started = true;

    io.to(roomId).emit("room-state", room);
  });

  socket.on("submit-word", ({ word }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    io.to(roomId).emit("word-submitted", {
      playerId: socket.id,
      username: socket.data.username,
      word,
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;

    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.players = room.players.filter(
      (player) => player.id !== socket.id
    );

    if (room.players.length === 0) {
      rooms.delete(roomId);
      console.log(`Deleted empty room ${roomId}`);
      return;
    }

    io.to(roomId).emit("room-state", room);

    console.log(`${socket.data.username} left room ${roomId}`);
  });
});

console.log(`Socket.IO server running on port ${port}`);
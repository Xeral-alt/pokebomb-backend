import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";

const PORT = Number(process.env.PORT ?? 3000);

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        ok: true,
      }),
    );

    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/plain",
  });

  res.end("PokemonBomb server");
});

const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL ?? "*",
  },
});

/* -------------------------------------------------------------------------- */
/*                                    TYPES                                   */
/* -------------------------------------------------------------------------- */

type Role = "player" | "spectator";

type User = {
  id: string;
  username: string;
  role: Role;
  lives: number;
};

type Settings = {
  countdownSeconds: number;
  turnSeconds: number;
  minMatches: number;
  initialLives: number;
  maxLives: number;
  healOnCorrect: boolean;
};

type RoomStatus = "lobby" | "playing";

type Room = {
  id: string;

  hostId: string;

  users: Map<string, User>;

  status: RoomStatus;

  settings: Settings;

  countdownPaused: boolean;
  countdownEndsAt: number | null;
  countdownRemaining: number | null;
  countdownTimer: ReturnType<typeof setTimeout> | null;

  playerOrder: string[];
  currentPlayerIndex: number;

  syllable: string | null;
  turnEndsAt: number | null;
  turnTimer: ReturnType<typeof setTimeout> | null;

  usedPokemon: Set<string>;
};

type PokemonSpeciesResponse = {
  results: Array<{
    name: string;
    url: string;
  }>;
};

type JoinResponse = {
  ok: boolean;
  message?: string;
};

type SubmissionReason = "not-pokemon" | "already-used" | "wrong-syllable";

/* -------------------------------------------------------------------------- */
/*                               GLOBAL STATE                                 */
/* -------------------------------------------------------------------------- */

const rooms = new Map<string, Room>();

const pokemonNames = new Set<string>();

/**
 * Fragmento de dos letras -> Pokémon que lo contienen.
 *
 * Ejemplo:
 * "pi" -> ["pikachu", "piplup", ...]
 */
const syllableIndex = new Map<string, string[]>();

/* -------------------------------------------------------------------------- */
/*                                 POKEAPI                                    */
/* -------------------------------------------------------------------------- */

function normalizePokemonName(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[\s_'".-]/g, "");
}

async function loadPokemon() {
  console.log("Cargando Pokémon desde PokéAPI...");

  const response = await fetch(
    "https://pokeapi.co/api/v2/pokemon-species?limit=100000&offset=0",
  );

  if (!response.ok) {
    throw new Error(`PokéAPI respondió ${response.status}`);
  }

  const data = (await response.json()) as PokemonSpeciesResponse;

  pokemonNames.clear();

  for (const result of data.results) {
    pokemonNames.add(normalizePokemonName(result.name));
  }

  buildSyllableIndex();

  console.log(`Pokémon cargados: ${pokemonNames.size}`);

  console.log(`Fragmentos generados: ${syllableIndex.size}`);
}

function buildSyllableIndex() {
  syllableIndex.clear();

  for (const pokemon of pokemonNames) {
    const fragments = new Set<string>();

    for (let i = 0; i < pokemon.length - 1; i++) {
      const fragment = pokemon.slice(i, i + 2);

      if (!/^[a-z]{2}$/.test(fragment)) {
        continue;
      }

      fragments.add(fragment);
    }

    for (const fragment of fragments) {
      const current = syllableIndex.get(fragment) ?? [];

      current.push(pokemon);

      syllableIndex.set(fragment, current);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                  ROOMS                                     */
/* -------------------------------------------------------------------------- */

function createRoom(roomId: string, hostId: string): Room {
  return {
    id: roomId,

    hostId,

    users: new Map(),

    status: "lobby",

    settings: {
      countdownSeconds: 10,
      turnSeconds: 10,
      minMatches: 5,
      initialLives: 3,
      maxLives: 3,
      healOnCorrect: true,
    },

    countdownPaused: false,
    countdownEndsAt: null,
    countdownRemaining: null,
    countdownTimer: null,

    playerOrder: [],
    currentPlayerIndex: 0,

    syllable: null,
    turnEndsAt: null,
    turnTimer: null,

    usedPokemon: new Set(),
  };
}

function getPlayers(room: Room) {
  return [...room.users.values()].filter((user) => user.role === "player");
}

function getPublicRoom(room: Room) {
  const users = [...room.users.values()];

  return {
    id: room.id,

    hostId: room.hostId,

    status: room.status,

    settings: room.settings,

    countdownPaused: room.countdownPaused,

    countdownEndsAt: room.countdownEndsAt,

    countdownRemaining: room.countdownRemaining,

    players: users.filter((user) => user.role === "player"),

    spectators: users.filter((user) => user.role === "spectator"),

    playerOrder: room.playerOrder,

    currentPlayerId:
      room.status === "playing"
        ? (room.playerOrder[room.currentPlayerIndex] ?? null)
        : null,

    syllable: room.syllable,

    turnEndsAt: room.turnEndsAt,

    usedPokemonCount: room.usedPokemon.size,
  };
}

function broadcastRoom(room: Room) {
  io.to(room.id).emit("room-state", getPublicRoom(room));
}

/* -------------------------------------------------------------------------- */
/*                               COUNTDOWN                                    */
/* -------------------------------------------------------------------------- */

function clearCountdownTimer(room: Room) {
  if (room.countdownTimer) {
    clearTimeout(room.countdownTimer);
  }

  room.countdownTimer = null;
}

function cancelCountdown(room: Room) {
  clearCountdownTimer(room);

  room.countdownEndsAt = null;

  room.countdownRemaining = null;

  broadcastRoom(room);
}

function evaluateCountdown(room: Room) {
  if (room.status !== "lobby") {
    return;
  }

  const players = getPlayers(room);

  if (players.length < 2) {
    if (room.countdownEndsAt !== null || room.countdownRemaining !== null) {
      cancelCountdown(room);
    }

    return;
  }

  if (room.countdownPaused) {
    return;
  }

  if (room.countdownEndsAt !== null) {
    return;
  }

  startCountdown(room, room.settings.countdownSeconds);
}

function startCountdown(room: Room, seconds: number) {
  clearCountdownTimer(room);

  room.countdownRemaining = null;

  room.countdownEndsAt = Date.now() + seconds * 1000;

  room.countdownTimer = setTimeout(() => {
    room.countdownTimer = null;

    room.countdownEndsAt = null;

    room.countdownRemaining = null;

    startGame(room);
  }, seconds * 1000);

  broadcastRoom(room);
}

function pauseCountdown(room: Room) {
  if (room.countdownEndsAt !== null) {
    room.countdownRemaining = Math.max(
      1,
      Math.ceil((room.countdownEndsAt - Date.now()) / 1000),
    );
  }

  clearCountdownTimer(room);

  room.countdownEndsAt = null;

  room.countdownPaused = true;

  broadcastRoom(room);
}

function resumeCountdown(room: Room) {
  room.countdownPaused = false;

  if (getPlayers(room).length < 2) {
    room.countdownRemaining = null;

    broadcastRoom(room);

    return;
  }

  const seconds = room.countdownRemaining ?? room.settings.countdownSeconds;

  startCountdown(room, seconds);
}

/* -------------------------------------------------------------------------- */
/*                                   GAME                                     */
/* -------------------------------------------------------------------------- */

function clearTurnTimer(room: Room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
  }

  room.turnTimer = null;
}

function resetGameState(room: Room) {
  clearTurnTimer(room);
  clearCountdownTimer(room);

  room.status = "lobby";

  room.playerOrder = [];
  room.currentPlayerIndex = 0;

  room.syllable = null;

  room.turnEndsAt = null;

  room.usedPokemon.clear();

  room.countdownPaused = false;

  room.countdownEndsAt = null;

  room.countdownRemaining = null;
}

function startGame(room: Room) {
  const players = getPlayers(room);

  if (players.length < 2) {
    resetGameState(room);
    broadcastRoom(room);

    return;
  }

  clearCountdownTimer(room);

  room.status = "playing";

  room.countdownEndsAt = null;

  room.countdownRemaining = null;

  room.countdownPaused = false;

  room.usedPokemon.clear();

  room.playerOrder = players.map((player) => player.id);

  room.currentPlayerIndex = 0;

  for (const player of players) {
    player.lives = room.settings.initialLives;
  }

  io.to(room.id).emit("game-started");

  startTurn(room);
}

function getAvailableSyllables(room: Room) {
  const available: Array<{
    syllable: string;
    matchCount: number;
  }> = [];

  for (const [syllable, pokemon] of syllableIndex.entries()) {
    let matches = 0;

    for (const name of pokemon) {
      if (!room.usedPokemon.has(name)) {
        matches++;
      }
    }

    if (matches >= room.settings.minMatches) {
      available.push({
        syllable,
        matchCount: matches,
      });
    }
  }

  return available;
}

function pickSyllable(room: Room) {
  const available = getAvailableSyllables(room);

  if (available.length === 0) {
    return null;
  }

  return available[Math.floor(Math.random() * available.length)];
}

function startTurn(room: Room) {
  clearTurnTimer(room);

  const alivePlayers = room.playerOrder.filter((id) => {
    const player = room.users.get(id);

    return player && player.role === "player" && player.lives > 0;
  });

  if (alivePlayers.length <= 1) {
    finishGame(room, alivePlayers[0] ?? null);

    return;
  }

  room.playerOrder = alivePlayers;

  if (room.currentPlayerIndex >= room.playerOrder.length) {
    room.currentPlayerIndex = 0;
  }

  const selected = pickSyllable(room);

  if (!selected) {
    io.to(room.id).emit("game-message", {
      type: "error",
      message:
        "No quedan fragmentos que cumplan la cantidad mínima de coincidencias.",
    });

    finishGame(room, null);

    return;
  }

  room.syllable = selected.syllable;

  room.turnEndsAt = Date.now() + room.settings.turnSeconds * 1000;

  room.turnTimer = setTimeout(() => {
    handleTurnTimeout(room);
  }, room.settings.turnSeconds * 1000);

  broadcastRoom(room);
}

function handleTurnTimeout(room: Room) {
  const playerId = room.playerOrder[room.currentPlayerIndex];

  if (!playerId) {
    nextTurn(room);

    return;
  }

  const player = room.users.get(playerId);

  if (!player) {
    nextTurn(room);

    return;
  }

  player.lives = Math.max(0, player.lives - 1);

  io.to(room.id).emit("turn-result", {
    success: false,
    playerId,
    reason: "timeout",
  });

  if (player.lives <= 0) {
    player.role = "spectator";
  }

  nextTurn(room);
}

function nextTurn(room: Room) {
  clearTurnTimer(room);

  room.turnEndsAt = null;

  room.syllable = null;

  room.currentPlayerIndex += 1;

  startTurn(room);
}

function emitSubmissionResult(
  room: Room,
  value: {
    success: boolean;
    playerId: string;
    pokemon: string;
    reason?: SubmissionReason;
  },
) {
  io.to(room.id).emit("submission-result", value);
}

function submitPokemon(room: Room, socket: Socket, rawPokemon: string) {
  if (room.status !== "playing") {
    return;
  }

  const currentPlayerId = room.playerOrder[room.currentPlayerIndex];

  if (socket.id !== currentPlayerId) {
    return;
  }

  const attemptedPokemon = rawPokemon.trim().replace(/\s+/g, " ");

  const pokemon = normalizePokemonName(attemptedPokemon);

  if (!pokemonNames.has(pokemon)) {
    emitSubmissionResult(room, {
      success: false,
      playerId: socket.id,
      reason: "not-pokemon",
      pokemon: attemptedPokemon,
    });

    return;
  }

  if (room.usedPokemon.has(pokemon)) {
    emitSubmissionResult(room, {
      success: false,
      playerId: socket.id,
      reason: "already-used",
      pokemon: attemptedPokemon,
    });

    return;
  }

  if (!room.syllable || !pokemon.includes(room.syllable)) {
    emitSubmissionResult(room, {
      success: false,
      playerId: socket.id,
      reason: "wrong-syllable",
      pokemon: attemptedPokemon,
    });

    return;
  }

  room.usedPokemon.add(pokemon);

  const player = room.users.get(socket.id);

  if (
    player &&
    room.settings.healOnCorrect &&
    player.lives < room.settings.maxLives
  ) {
    player.lives += 1;
  }

  emitSubmissionResult(room, {
    success: true,
    playerId: socket.id,
    pokemon,
  });

  nextTurn(room);
}

function finishGame(room: Room, winnerId: string | null) {
  clearTurnTimer(room);
  clearCountdownTimer(room);

  /*
   * Enviamos primero el ganador
   * mientras todavía existe el
   * estado de la partida.
   */
  io.to(room.id).emit("game-ended", {
    winnerId,
    winnerUsername: winnerId ? (room.users.get(winnerId)?.username ?? null) : null,
  });

  /*
   * Al terminar, TODOS pasan
   * a espectadores.
   */
  for (const user of room.users.values()) {
    user.role = "spectator";
    user.lives = room.settings.initialLives;
  }

  resetGameState(room);

  broadcastRoom(room);
}

/* -------------------------------------------------------------------------- */
/*                                SETTINGS                                    */
/* -------------------------------------------------------------------------- */

function safeInteger(value: unknown, fallback: number, min: number, max = 999) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(number)));
}

function updateRoomSettings(room: Room, settings: Partial<Settings>) {
  const current = room.settings;

  const maxLives =
    settings.maxLives !== undefined
      ? safeInteger(settings.maxLives, current.maxLives, 1, 20)
      : current.maxLives;

  const initialLives =
    settings.initialLives !== undefined
      ? safeInteger(settings.initialLives, current.initialLives, 1, maxLives)
      : Math.min(current.initialLives, maxLives);

  room.settings = {
    countdownSeconds:
      settings.countdownSeconds !== undefined
        ? safeInteger(
            settings.countdownSeconds,
            current.countdownSeconds,
            1,
            120,
          )
        : current.countdownSeconds,

    turnSeconds:
      settings.turnSeconds !== undefined
        ? safeInteger(settings.turnSeconds, current.turnSeconds, 2, 120)
        : current.turnSeconds,

    minMatches:
      settings.minMatches !== undefined
        ? safeInteger(settings.minMatches, current.minMatches, 1, 1000)
        : current.minMatches,

    initialLives,

    maxLives,

    healOnCorrect:
      typeof settings.healOnCorrect === "boolean"
        ? settings.healOnCorrect
        : current.healOnCorrect,
  };
}

/* -------------------------------------------------------------------------- */
/*                                SOCKET.IO                                   */
/* -------------------------------------------------------------------------- */

io.on("connection", (socket) => {
  console.log("Conectado:", socket.id);

  socket.on(
    "join-room",
    (
      {
        roomId,
        username,
      }: {
        roomId: string;
        username: string;
      },
      callback?: (response: JoinResponse) => void,
    ) => {
      const cleanRoomId = roomId?.trim();

      const cleanUsername = username?.trim().replace(/\s+/g, " ");

      if (!cleanRoomId || !cleanUsername) {
        callback?.({
          ok: false,
          message: "Nombre o sala inválidos.",
        });

        return;
      }

      let room = rooms.get(cleanRoomId);

      if (!room) {
        room = createRoom(cleanRoomId, socket.id);

        rooms.set(cleanRoomId, room);
      }

      /*
       * Los nombres son únicos
       * ignorando mayúsculas.
       */
      const normalizedUsername = cleanUsername.toLocaleLowerCase("es");

      const usernameTaken = [...room.users.values()].some(
        (user) =>
          user.username.trim().toLocaleLowerCase("es") === normalizedUsername,
      );

      if (usernameTaken) {
        callback?.({
          ok: false,
          message: "Ese nombre ya está siendo usado en esta sala.",
        });

        return;
      }

      socket.join(cleanRoomId);

      room.users.set(socket.id, {
        id: socket.id,
        username: cleanUsername,
        role: "spectator",
        lives: room.settings.initialLives,
      });

      socket.data.roomId = cleanRoomId;

      /*
       * IMPORTANTE:
       * respondemos el ACK antes
       * de room-state.
       *
       * Esto evita una carrera
       * con el App.tsx.
       */
      callback?.({
        ok: true,
      });

      broadcastRoom(room);
    },
  );

  socket.on("join-game", () => {
    const roomId = socket.data.roomId;

    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);

    if (!room || room.status !== "lobby") {
      return;
    }

    const user = room.users.get(socket.id);

    if (!user) {
      return;
    }

    user.role = "player";

    user.lives = room.settings.initialLives;

    broadcastRoom(room);

    evaluateCountdown(room);
  });

  socket.on("leave-game", () => {
    const roomId = socket.data.roomId;

    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);

    if (!room || room.status !== "lobby") {
      return;
    }

    const user = room.users.get(socket.id);

    if (!user) {
      return;
    }

    user.role = "spectator";

    broadcastRoom(room);

    evaluateCountdown(room);
  });

  socket.on("update-settings", (settings: Partial<Settings>) => {
    const roomId = socket.data.roomId;

    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);

    if (!room || room.hostId !== socket.id || room.status !== "lobby") {
      return;
    }

    updateRoomSettings(room, settings);

    /*
     * Cambiar settings reinicia
     * la cuenta de inicio.
     */
    clearCountdownTimer(room);

    room.countdownEndsAt = null;

    room.countdownRemaining = null;

    broadcastRoom(room);

    evaluateCountdown(room);
  });

  socket.on("pause-countdown", () => {
    const roomId = socket.data.roomId;

    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);

    if (!room || room.hostId !== socket.id || room.status !== "lobby") {
      return;
    }

    pauseCountdown(room);
  });

  socket.on("resume-countdown", () => {
    const roomId = socket.data.roomId;

    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);

    if (!room || room.hostId !== socket.id || room.status !== "lobby") {
      return;
    }

    resumeCountdown(room);
  });

  socket.on("submit-pokemon", ({ pokemon }: { pokemon: string }) => {
    const roomId = socket.data.roomId;

    if (!roomId || !pokemon) {
      return;
    }

    const room = rooms.get(roomId);

    if (!room) {
      return;
    }

    submitPokemon(room, socket, pokemon);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;

    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);

    if (!room) {
      return;
    }

    room.users.delete(socket.id);

    if (room.users.size === 0) {
      clearTurnTimer(room);

      clearCountdownTimer(room);

      rooms.delete(roomId);

      console.log(`Sala eliminada: ${roomId}`);

      return;
    }

    /*
     * Migración automática
     * del host.
     */
    if (room.hostId === socket.id) {
      const nextHostId = room.users.keys().next().value;

      if (nextHostId) {
        room.hostId = nextHostId;
      }
    }

    if (room.status === "playing") {
      const playerIndex = room.playerOrder.indexOf(socket.id);

      if (playerIndex !== -1) {
        room.playerOrder.splice(playerIndex, 1);

        if (playerIndex < room.currentPlayerIndex) {
          room.currentPlayerIndex--;
        }

        if (room.currentPlayerIndex >= room.playerOrder.length) {
          room.currentPlayerIndex = 0;
        }
      }

      const remaining = room.playerOrder.filter((id) => {
        const user = room.users.get(id);

        return user && user.role === "player" && user.lives > 0;
      });

      if (remaining.length <= 1) {
        finishGame(room, remaining[0] ?? null);

        return;
      }

      /*
       * Si quien salió era el
       * jugador activo, iniciamos
       * otro turno.
       */
      if (socket.id === room.playerOrder[room.currentPlayerIndex]) {
        startTurn(room);

        return;
      }
    }

    broadcastRoom(room);

    evaluateCountdown(room);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  START                                     */
/* -------------------------------------------------------------------------- */

await loadPokemon();

httpServer.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});

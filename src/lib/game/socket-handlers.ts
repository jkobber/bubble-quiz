import { Server, Socket } from "socket.io";
import { GameManager } from "./GameManager";
import { startGameLoop } from "./loop";
import pino from "pino";

const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      ignore: "pid,hostname",
      translateTime: "SYS:standard",
    },
  },
});

export function registerHandlers(io: Server, socket: Socket, gameManager: GameManager) {
  socket.on("create_room", (data) => {
    const code = Math.random().toString(36).substring(7).toUpperCase();
    const playerToken = data.playerToken || socket.id;

    // Use playerToken as hostToken
    const room = gameManager.createRoom(code, playerToken);
    socket.join(code);

    // Add host as player immediately
    room.players[playerToken] = {
      token: playerToken,
      socketId: socket.id,
      name: data.playerName || "Host",
      avatar: data.playerAvatar || "",
      score: 0,
      connected: true,
      lastSeen: Date.now(),
      joker5050: true,
      jokerSpy: true,
      jokerRisk: true,
      selectedChoice: null,
      usedRiskThisQ: false,
      usedSpyThisQ: false,
      used5050ThisQ: false,
    };

    socket.emit("room:created", { code });
    io.to(code).emit("room:update", { room });
  });

  socket.on("join_room", (data) => {
    const code = typeof data === "string" ? data : data.code;
    const playerToken = data.playerToken || socket.id;
    const name =
      typeof data === "object" && data.name
        ? data.name
        : `Player ${Math.floor(Math.random() * 1000)}`;
    const avatar = typeof data === "object" && data.avatar ? data.avatar : "";

    const room = gameManager.getRoom(code);
    if (room) {
      room.lastActivity = Date.now();
      socket.join(code);

      // Check if player exists by token
      if (room.players[playerToken]) {
        // Reconnect
        const p = room.players[playerToken];
        p.socketId = socket.id;
        p.connected = true;
        p.lastSeen = Date.now();
        // Update name/avatar if provided (optional, maybe only if not set?)
        if (name) p.name = name;
        if (avatar) p.avatar = avatar;
      } else {
        // New Player
        room.players[playerToken] = {
          token: playerToken,
          socketId: socket.id,
          name: name,
          avatar: avatar,
          score: 0,
          connected: true,
          lastSeen: Date.now(),
          joker5050: true,
          jokerSpy: true,
          jokerRisk: true,
          selectedChoice: null,
          usedRiskThisQ: false,
          usedSpyThisQ: false,
          used5050ThisQ: false,
        };
      }

      socket.emit("room:joined", { code });
      io.to(code).emit("room:update", { room });
    } else {
      socket.emit("error", "Room not found");
    }
  });

  socket.on("start_game", async (data) => {
    const code = typeof data === "string" ? data : data.code;
    const config = typeof data === "object" ? data.config : {};

    const room = gameManager.getRoom(code);
    // Find player by socket
    const player = Object.values(room?.players || {}).find(
      (p) => p.socketId === socket.id
    );

    if (room && player && room.hostToken === player.token) {
      await gameManager.startGame(room, config);
      io.to(code).emit("room:update", { room });
      startGameLoop(room, io, gameManager);
    }
  });

  socket.on("update_settings", ({ code, settings }) => {
    const room = gameManager.getRoom(code);
    const player = Object.values(room?.players || {}).find(
      (p) => p.socketId === socket.id
    );

    if (
      room &&
      player &&
      room.hostToken === player.token &&
      room.phase === "lobby"
    ) {
      room.settings = { ...room.settings, ...settings };
      io.to(code).emit("room:update", { room });
    }
  });

  socket.on("submit_answer", async ({ code, choice }) => {
    const room = gameManager.getRoom(code);
    const player = Object.values(room?.players || {}).find(
      (p) => p.socketId === socket.id
    );

    if (room && room.phase === "question" && player) {
      room.lastActivity = Date.now();
      player.selectedChoice = choice;

      // Emit update so host sees progress
      io.to(code).emit("room:update", { room });

      // Check if all answered
      const allAnswered = Object.values(room.players).every(
        (p) => p.selectedChoice !== null
      );
      if (allAnswered) {
        // Force reveal early
        await gameManager.revealAnswer(room);
        room.revealDeadlineTs = Date.now() + 5000; // 5s reveal
        room.qDeadlineTs = null; // Clear question timer
        io.to(code).emit("room:update", { room });
      }
    }
  });

  socket.on("use_joker", ({ code, type }) => {
    const room = gameManager.getRoom(code);
    if (!room || room.phase !== "question") return;

    const player = Object.values(room.players).find(
      (p) => p.socketId === socket.id
    );
    if (!player) return;

    // Concurrency Limit Check
    if (!room.settings.simultaneousJokers && room.jokerUsedThisQ) {
      socket.emit("error", "Joker already used this round!");
      return;
    }

    if (type === "5050" && player.joker5050) {
      player.joker5050 = false;
      player.used5050ThisQ = true;
      room.jokerUsedThisQ = true;

      const correct = room.correctIndex!;
      const allIndices = [0, 1, 2, 3];
      const wrongIndices = allIndices.filter((i) => i !== correct);
      wrongIndices.sort(() => Math.random() - 0.5);
      const removeIndices = wrongIndices.slice(0, 2);

      socket.emit("joker_effect", { type: "5050", remove: removeIndices });
      io.to(code).emit("joker_triggered", {
        playerToken: player.token,
        playerName: player.name,
        type: "5050",
      });
      io.to(code).emit("room:update", { room });
    } else if (type === "risk" && player.jokerRisk) {
      player.jokerRisk = false;
      player.usedRiskThisQ = true;
      room.jokerUsedThisQ = true;
      io.to(code).emit("joker_triggered", {
        playerToken: player.token,
        playerName: player.name,
        type: "risk",
      });
      io.to(code).emit("room:update", { room });
    } else if (type === "spy" && player.jokerSpy) {
      player.jokerSpy = false;
      player.usedSpyThisQ = true;
      room.jokerUsedThisQ = true;
      socket.emit("joker_effect", {
        type: "spy",
        message: "Spy Active: Watching answers...",
      });
      io.to(code).emit("joker_triggered", {
        playerToken: player.token,
        playerName: player.name,
        type: "spy",
      });
      io.to(code).emit("room:update", { room });
    }
  });

  socket.on("delete_room", (data) => {
    const code = typeof data === "string" ? data : data.code;
    const room = gameManager.getRoom(code);
    const player = Object.values(room?.players || {}).find(
      (p) => p.socketId === socket.id
    );

    if (room && player && room.hostToken === player.token) {
      gameManager.deleteRoom(code);
      io.to(code).emit("room:deleted");
      // Redundant emit to sender to ensure they get redirected even if socket room logic fails
      socket.emit("room:deleted");
    } else {
      socket.emit("error", "Failed to delete room: Unauthorized or room not found");
      // If room not found, we might want to tell them it's deleted anyway so they leave
      if (!room) {
         socket.emit("room:deleted");
      }
    }
  });

  socket.on("pause_timer", ({ code }) => {
    const room = gameManager.getRoom(code);
    const player = Object.values(room?.players || {}).find(
      (p) => p.socketId === socket.id
    );
    if (room && player && room.hostToken === player.token && !room.paused) {
      room.paused = true;
      const now = Date.now();
      if (room.phase === "question" && room.qDeadlineTs) {
        room.pauseRemaining = Math.max(0, room.qDeadlineTs - now);
        room.qDeadlineTs = null;
      } else if (room.phase === "reveal" && room.revealDeadlineTs) {
        room.pauseRemaining = Math.max(0, room.revealDeadlineTs - now);
        room.revealDeadlineTs = null;
      }
      io.to(code).emit("room:update", { room });
    }
  });

  socket.on("resume_timer", ({ code }) => {
    const room = gameManager.getRoom(code);
    const player = Object.values(room?.players || {}).find(
      (p) => p.socketId === socket.id
    );
    if (room && player && room.hostToken === player.token && room.paused) {
      room.paused = false;
      const now = Date.now();
      if (room.phase === "question" && room.pauseRemaining !== undefined) {
        room.qDeadlineTs = now + room.pauseRemaining;
      } else if (
        room.phase === "reveal" &&
        room.pauseRemaining !== undefined
      ) {
        room.revealDeadlineTs = now + room.pauseRemaining;
      }
      room.pauseRemaining = undefined;
      io.to(code).emit("room:update", { room });
    }
  });

  socket.on("skip_phase", async ({ code }) => {
    const room = gameManager.getRoom(code);
    const player = Object.values(room?.players || {}).find(
      (p) => p.socketId === socket.id
    );
    if (room && player && room.hostToken === player.token) {
      room.paused = false;
      room.pauseRemaining = undefined;

      if (room.phase === "question") {
        await gameManager.revealAnswer(room);
        room.revealDeadlineTs = Date.now() + 5000;
        io.to(code).emit("room:update", { room });
      } else if (room.phase === "reveal") {
        await gameManager.nextQuestion(room);
        io.to(code).emit("room:update", { room });
      }
    }
  });

  socket.on("disconnect", () => {
    logger.info(`Client disconnected: ${socket.id}`);
    const result = gameManager.handleDisconnect(socket.id);
    if (result) {
      const { roomCode } = result;
      const room = gameManager.getRoom(roomCode);
      if (room) {
        io.to(roomCode).emit("room:update", { room });
      }
    }
  });
}

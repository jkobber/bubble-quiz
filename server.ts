import { createServer } from "node:http";
import next from "next";
import { Server } from "socket.io";
import { gameManager } from "./src/lib/game/GameManager";
import pino from "pino";
import cron from "node-cron";
import path from "path";
import { performBackup } from "./src/lib/backup";

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

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = 3000;
const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();

app.prepare().then(() => {
  const io = new Server({
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  const httpServer = createServer((req, res) => {
    logger.info(`[HTTP] ${req.method} ${req.url}`);
    if (req.url?.startsWith("/socket.io")) {
      // logger.debug(`[SOCKET] SIO Request: ${req.url}`);
      io.engine.handleRequest(req as any, res as any);
      return;
    }

    if (req.url === "/api/lobbies" && req.method === "GET") {
      const rooms = gameManager.getPublicRooms();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(rooms));
      return;
    }

    handler(req, res);
  });

  io.attach(httpServer);

  io.on("connection", (socket) => {
    logger.info(`Client connected: ${socket.id}`);

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
        startGameLoop(room, io);
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
      // If strict mode on, check if joker already used this Q
      if (!room.settings.simultaneousJokers && room.jokerUsedThisQ) {
        socket.emit("error", "Joker already used this round!");
        return;
      }

      if (type === "5050" && player.joker5050) {
        player.joker5050 = false;
        player.used5050ThisQ = true;
        room.jokerUsedThisQ = true;

        // Calculate wrong options to remove
        const correct = room.correctIndex!;
        const allIndices = [0, 1, 2, 3];
        const wrongIndices = allIndices.filter((i) => i !== correct);
        // Shuffle wrong indices
        wrongIndices.sort(() => Math.random() - 0.5);
        // Take 2 to remove
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
        // Spy gets data immediately about CURRENT picks (if any) and will get future ones via room:update potentially if we expose it
        // Actually, our room:update sends `livePicks` but it's usually empty/null to hide answers.
        // We need to ensure `livePicks` is populated IF we want generic updates,
        // OR we send specific spy data.
        // Let's rely on room:update but we need to modify GameLoop/State to expose livePicks to SPIES only?
        // That's tricky with broadcast.
        // Better: Broadcast everything, but assume client handles secrecy? NO, insecure.
        // Better: Send specific event to spy.
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

    socket.on("delete_room", ({ code }) => {
      const room = gameManager.getRoom(code);
      const player = Object.values(room?.players || {}).find(
        (p) => p.socketId === socket.id
      );

      if (room && player && room.hostToken === player.token) {
        gameManager.deleteRoom(code);
        io.to(code).emit("room:deleted");
        // Disconnect all sockets in room? Or let client handle redirect
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
        // Reset pause state on skip
        room.paused = false;
        room.pauseRemaining = undefined;

        if (room.phase === "question") {
          // Skip to reveal
          await gameManager.revealAnswer(room);
          // Set reveal timer
          room.revealDeadlineTs = Date.now() + 5000;
          io.to(code).emit("room:update", { room });
        } else if (room.phase === "reveal") {
          // Skip to next question
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
  });

  // Backup Scheduler
  const backupSchedule = process.env.BACKUP_SCHEDULE || "0 0 * * *"; // Default: Every midnight
  const backupDir =
    process.env.BACKUP_DIR || path.join(process.cwd(), "backups");
  const backupRetention = parseInt(process.env.BACKUP_RETENTION || "5", 10);
  const databaseUrl = process.env.DATABASE_URL || "file:./prisma/dev.db";

  logger.info(`Initializing Backup Scheduler: ${backupSchedule}`);

  cron.schedule(backupSchedule, async () => {
    logger.info("Starting scheduled database backup...");
    await performBackup(
      {
        databaseUrl,
        backupDir,
        retention: backupRetention,
      },
      logger
    );
  });

  httpServer
    .once("error", (err) => {
      logger.error(err);
      process.exit(1);
    })
    .listen(port, () => {
      logger.info(`> Backend Ready on http://${hostname}:${port}`);
    });

  // Graceful Shutdown
  const shutdown = () => {
    logger.info("Shutting down...");

    // Force close connections immediately for dev speed
    if (dev) {
      // @ts-ignore - closeAllConnections exists in Node 18+
      if (httpServer.closeAllConnections) httpServer.closeAllConnections();
    }

    const forceExit = setTimeout(() => {
      logger.error(
        "Could not close connections in time, forcefully shutting down"
      );
      process.exit(1);
    }, 3000); // 3s max wait

    io.close(() => {
      logger.info("Socket.io closed");
      httpServer.close(() => {
        logger.info("HTTP Server closed");
        clearTimeout(forceExit);
        process.exit(0);
      });
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
});

// Simple Game Loop / Timer Handler
function startGameLoop(room: any, io: Server) {
  const INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutes

  const interval = setInterval(async () => {
    if (room.phase === "finished") {
      clearInterval(interval);
      return;
    }

    const now = Date.now();

    // Check for inactivity
    const activePlayers = Object.values(room.players).filter(
      (p: any) => p.connected
    ).length;
    if (activePlayers === 0) {
      if (now - room.lastActivity > INACTIVITY_TIMEOUT) {
        logger.info(`Room ${room.code} timed out due to inactivity`);
        room.phase = "finished";
        io.to(room.code).emit("room:update", { room });
        clearInterval(interval);
        return;
      }
    } else {
      room.lastActivity = now;
    }

    if (room.paused) return; // Skip timer logic if paused

    if (room.phase === "question") {
      // Check Deadline
      if (room.qDeadlineTs && now >= room.qDeadlineTs) {
        // Time up -> Reveal
        await gameManager.revealAnswer(room);
        room.revealDeadlineTs = Date.now() + 5000; // 5s reveal
        io.to(room.code).emit("room:update", { room });
      }

      // Also check if all answered (Optional optimization)
      const allAnswered = Object.values(room.players).every(
        (p: any) => p.selectedChoice !== null
      );
      if (allAnswered && room.qDeadlineTs && now < room.qDeadlineTs) {
        // Force reveal early
        await gameManager.revealAnswer(room);
        room.revealDeadlineTs = Date.now() + 5000; // 5s reveal
        io.to(room.code).emit("room:update", { room });
      }
    } else if (room.phase === "reveal") {
      if (room.revealDeadlineTs && now >= room.revealDeadlineTs) {
        await gameManager.nextQuestion(room);
        io.to(room.code).emit("room:update", { room });
      }
    }
  }, 1000);
}

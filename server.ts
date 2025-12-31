import { createServer } from "node:http";
import next from "next";
import { Server } from "socket.io";
import { gameManager } from "./src/lib/game/GameManager";
import { startGameLoop } from "./src/lib/game/loop";
import { registerHandlers } from "./src/lib/game/socket-handlers";
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
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);
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
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.end(JSON.stringify(rooms));
      return;
    }

    handler(req, res);
  });

  io.attach(httpServer);

  io.on("connection", (socket) => {
    logger.info(`Client connected: ${socket.id}`);
    registerHandlers(io, socket, gameManager);
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
    .once("error", (err: any) => {
      logger.error(err);
      process.exit(1);
    })
    .listen(port, "0.0.0.0", () => {
      logger.info(`> Backend Ready on http://0.0.0.0:${port}`);
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

import path from "path";
import { performBackup } from "../src/lib/backup";

const DB_PATH =
  process.env.DATABASE_URL ||
  `file:${path.join(process.cwd(), "prisma", "dev.db")}`;
const BACKUP_DIR =
  process.env.BACKUP_DIR || path.join(process.cwd(), "backups");
const RETENTION = parseInt(process.env.BACKUP_RETENTION || "5", 10);

// Ensure DB_PATH has file: prefix if it's a path
const databaseUrl = DB_PATH.startsWith("file:") ? DB_PATH : `file:${DB_PATH}`;

console.log("Starting manual backup...");
performBackup({
  databaseUrl,
  backupDir: BACKUP_DIR,
  retention: RETENTION,
}).then(() => {
  console.log("Backup process completed.");
});

import fs from "fs";
import path from "path";

export interface BackupConfig {
  databaseUrl: string;
  backupDir: string;
  retention: number;
}

export async function performBackup(
  config: BackupConfig,
  logger: any = console
) {
  try {
    const { databaseUrl, backupDir, retention } = config;

    // Parse database path from URL
    let dbPath = "";
    if (databaseUrl.startsWith("file:")) {
      dbPath = databaseUrl.replace("file:", "");
    } else {
      logger.error(
        "Backup skipped: Only SQLite (file:) URLs are supported currently."
      );
      return;
    }

    // Resolve absolute path
    if (!path.isAbsolute(dbPath)) {
      dbPath = path.resolve(process.cwd(), dbPath);
    }

    if (!fs.existsSync(dbPath)) {
      logger.error(`Backup failed: Database file not found at ${dbPath}`);
      return;
    }

    // Ensure backup directory exists
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // Create backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFilename = `backup-${timestamp}.sqlite`;
    const backupPath = path.join(backupDir, backupFilename);

    fs.copyFileSync(dbPath, backupPath);
    logger.info(`Database backup created at: ${backupPath}`);

    // Rotate backups
    const files = fs
      .readdirSync(backupDir)
      .filter((file) => file.startsWith("backup-") && file.endsWith(".sqlite"))
      .map((file) => ({
        name: file,
        path: path.join(backupDir, file),
        time: fs.statSync(path.join(backupDir, file)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time); // Newest first

    if (files.length > retention) {
      const filesToDelete = files.slice(retention);
      filesToDelete.forEach((file) => {
        fs.unlinkSync(file.path);
        logger.info(`Deleted old backup: ${file.name}`);
      });
    }
  } catch (error) {
    logger.error("Backup failed with error:", error);
  }
}

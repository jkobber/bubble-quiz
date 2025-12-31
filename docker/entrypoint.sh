#!/bin/sh
set -e

# Fix permissions for data and backups
# This ensures the nextjs user can write to the mounted volumes
chown -R nextjs:nodejs /app/data /app/backups

# Run migrations as nextjs user
echo "Running database migrations..."
su-exec nextjs:nodejs npx prisma migrate deploy

# Start the application as nextjs user
echo "Starting application..."
exec su-exec nextjs:nodejs "$@"

#!/bin/bash

set -e

MESSAGE="${1:-Auto migration}"

echo "Upgrading database to latest revision..."
alembic upgrade head

echo "Generating migration..."
alembic revision --autogenerate -m "$MESSAGE"

# Find the latest migration file
LATEST_MIGRATION=$(ls -t alembic/versions/*.py | head -n 1)

# Check if the migration contains any operations
if grep -q "pass" "$LATEST_MIGRATION"; then
    echo "No schema changes detected. Removing empty migration..."
    rm "$LATEST_MIGRATION"
else
    echo "Applying migration..."
    alembic upgrade head
fi

echo "Starting application..."
exec python main.py
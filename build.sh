#!/bin/sh
# Joins the numbered SQL parts into the two files the owner pastes into Supabase:
#   setup.sql            a brand-new database (parts 01-07)
#   database-update.sql  the one-time update of a version 1 database (schema delta, then parts 02-07)
# Both end with the same lock-down (the end of part 07).
cd "$(dirname "$0")/supabase" || exit 1
cat sql/0*.sql > setup.sql && echo "setup.sql: $(wc -l < setup.sql) lines"
cat upgrade/00_header.sql upgrade/01_schema_delta.sql sql/02_*.sql sql/03_*.sql sql/04_*.sql sql/05_*.sql sql/06_*.sql sql/07_*.sql upgrade/99_footer.sql > database-update.sql \
  && echo "database-update.sql: $(wc -l < database-update.sql) lines"

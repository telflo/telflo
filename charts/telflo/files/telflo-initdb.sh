#!/bin/sh
# Runs telflo-bootstrap.sql once, when the postgres image's entrypoint
# creates a new data directory (it runs the executable *.sh files in
# /docker-entrypoint-initdb.d, and only then). The chart mounts this file
# there with mode 0555 (a file without the executable bit would be sourced,
# and its exec would replace the entrypoint), beside the opamp-server's
# initdb.sh; telflo-bootstrap.sql itself is mounted outside that folder, at
# /telflo-bootstrap, so the entrypoint never runs it a second time as a
# *.sql file.
#
# The owner's password reaches telflo-bootstrap.sql through this process's
# environment (TELFLO_OWNER_PASSWORD, read with \getenv), never a command
# line.
#
# log_min_error_statement=panic keeps a failing statement out of Postgres's
# log: the statements that set the password take no bind parameters, so a
# failed one would be logged whole, password and all.
set -eu
PGOPTIONS='-c log_min_error_statement=panic'
export PGOPTIONS
exec psql -X -v ON_ERROR_STOP=1 --no-password --username "$POSTGRES_USER" --dbname postgres \
  -f /telflo-bootstrap/telflo-bootstrap.sql

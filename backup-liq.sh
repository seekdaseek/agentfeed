#!/bin/bash
# nightly liquidations DB backup, 14-day rotation
sqlite3 /opt/agentfeed/liquidations.db ".backup /opt/agentfeed/backups/liquidations-$(date +%Y%m%d).db"
gzip -f /opt/agentfeed/backups/liquidations-$(date +%Y%m%d).db
find /opt/agentfeed/backups -name "liquidations-*.db.gz" -mtime +14 -delete

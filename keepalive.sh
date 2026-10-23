#!/bin/bash
# Keep-alive + watchdog for StreamVibe
# - Pings the server every 5 minutes to keep the sandbox active
# - Restarts the server automatically if it is not responding

cd "$(dirname "$0")" || exit 1

while true; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  if [ "$code" != "200" ]; then
    echo "$(date): server not responding (code=$code) - restarting" >> /tmp/logs/keepalive.log
    pkill -x node 2>/dev/null
    sleep 1
    NO_OPEN=1 setsid node server.js >> /tmp/logs/server.log 2>&1 < /dev/null &
  fi
  sleep 300
done

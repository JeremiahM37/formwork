#!/usr/bin/env bash
#
# Bring up the four pieces in the order they depend on each other, then hand
# the foreground to the dashboard so the container's life is the dashboard's.
#
# The awkward part is the middle: an extension's optional host permissions can
# only be granted by a person clicking through a native dialog, which nothing
# in a container can do. So the browser is started, its profile is seeded, and
# then it is restarted once with the model's origin written into the profile's
# own permission record. That costs a few seconds at startup and is the only
# way the extension can reach the model without someone driving a mouse.
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-20}"
GEOMETRY="${FORMWORK_GEOMETRY:-1920x1080x24}"
VNC_PORT=5920
WEB_PORT="${FORMWORK_NOVNC_PORT:-9112}"
API_PORT="${FORMWORK_PORT:-9113}"
CHROME_PROFILE="${FORMWORK_CHROME_PROFILE:-/state/chrome}"
MODEL_URL="${FORMWORK_MODEL_URL:-http://localhost:9105/api/jobfill/complete}"
EXT_DIR=/app/extension

export DISPLAY=":${DISPLAY_NUM}"
mkdir -p "${CHROME_PROFILE}" "${FORMWORK_STATE_DIR:-/state}"

log() { printf '%s formwork: %s\n' "$(date -u +%H:%M:%S)" "$*"; }

cleanup() { pkill -P $$ >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# ----------------------------------------------------------------- a desktop

# A restarted container keeps its filesystem, and Xvfb refuses to start onto a
# display whose lock file is still lying there from the process that was killed.
# `docker restart` is the most ordinary thing anyone will do to this, and
# without these two lines it never comes back.
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"

log "starting the display"
Xvfb ":${DISPLAY_NUM}" -screen 0 "${GEOMETRY}" -nolisten tcp &
for _ in $(seq 1 60); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.25; done
xdpyinfo >/dev/null 2>&1 || { log "Xvfb never came up"; exit 1; }

openbox &
x11vnc -display ":${DISPLAY_NUM}" -localhost -rfbport "${VNC_PORT}" \
       -forever -shared -nopw -noxdamage -quiet -bg -o /tmp/x11vnc.log
websockify --web=/usr/share/novnc "0.0.0.0:${WEB_PORT}" "localhost:${VNC_PORT}" &
log "a view of it is on :${WEB_PORT}"

# ----------------------------------------------------------------- a browser

chrome_args=(
  --user-data-dir="${CHROME_PROFILE}"
  --load-extension="${EXT_DIR}"
  --disable-extensions-except="${EXT_DIR}"
  --remote-debugging-port=9223
  --no-first-run --no-default-browser-check --password-store=basic
  --disable-features=Translate,MediaRouter
  --window-position=0,0 --window-size=1920,1040
  # Containers do not get the namespaces Chromium's sandbox needs, and the
  # alternative — running it privileged — trades a real boundary for a nominal
  # one. The browser is reachable only from inside this container.
  --no-sandbox --disable-dev-shm-usage
)

# Whichever Chromium the installed playwright package expects. Asking the
# package rather than hardcoding a path is what keeps this working across an
# upgrade that changes the browser revision.
CHROMIUM="$(node -e 'console.log(require("playwright").chromium.executablePath())')"
[ -x "${CHROMIUM}" ] || { log "no chromium at ${CHROMIUM}"; exit 1; }

start_browser() {
  "${CHROMIUM}" "${chrome_args[@]}" about:blank &
  BROWSER_PID=$!
  for _ in $(seq 1 80); do
    curl -fsS -m 2 http://localhost:9223/json/version >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  log "the browser never opened its debugging port"
  return 1
}

# Chromium's singleton locks name the process that held them; a dead one makes
# it exit immediately, reporting only that the profile is already in use.
rm -f "${CHROME_PROFILE}/Singleton"* 2>/dev/null || true

log "starting the browser"
start_browser
sleep 3

# ------------------------------------------------------- profile and permission

log "seeding the profile"
node /app/server/dashboard/seed.mjs || log "nothing seeded — mount a profile at /profile"

# Grant the extension the model's origin, unless the profile already carries it.
# The browser has to be stopped before Preferences is touched: Chrome holds that
# file in memory and rewrites it on exit, so patching a running browser is undone
# by the browser a moment later, and looks exactly like the patch failing.
GRANT_FLAGS=()
if [ "${FORMWORK_ALLOW_ALL_HOSTS:-0}" = "1" ]; then
  GRANT_FLAGS+=(--all-hosts)
  log "FORMWORK_ALLOW_ALL_HOSTS is set — the extension may read and fill any page in this browser"
fi

if ! python3 /app/docker/grant-host.py --check "${GRANT_FLAGS[@]}" "${CHROME_PROFILE}" "${MODEL_URL}" "${EXT_DIR}"; then
  log "granting the extension access to the model — restarting the browser once"
  kill "${BROWSER_PID}" 2>/dev/null || true
  wait "${BROWSER_PID}" 2>/dev/null || true
  sleep 2
  rm -f "${CHROME_PROFILE}/Singleton"* 2>/dev/null || true
  python3 /app/docker/grant-host.py "${GRANT_FLAGS[@]}" "${CHROME_PROFILE}" "${MODEL_URL}" "${EXT_DIR}" \
    || log "could not grant it — model-derived answers will be missing"
  start_browser
fi

# ---------------------------------------------------------------- the dashboard

log "dashboard on :${API_PORT}"
cd /app/server
exec /opt/venv/bin/uvicorn dashboard.app:app --host 0.0.0.0 --port "${API_PORT}"

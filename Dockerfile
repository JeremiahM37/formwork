# formwork, whole.
#
# One image holds the four things that have to agree with each other: a browser
# with the extension loaded, a view of that browser you can take over, the
# dashboard that drives it, and a LaTeX engine to build a tailored résumé. They
# are together because they are coupled — the dashboard talks to the browser
# over its debugging port on localhost, and hands it documents off a shared
# disk. Splitting them across containers would mean publishing that debugging
# port on a network, which is a remote-code-execution hole with a nice name.
#
# Chromium comes from Playwright's own installer rather than from a base image
# that ships it. Two reasons, and both cost a rebuild to learn: the browser
# revision has to match the installed playwright package or executablePath()
# points at nothing, and an image that ships three browsers still weighs three
# browsers however many you delete afterwards — layers only add.
#
# It has to be Playwright's Chromium specifically. Chrome stable no longer
# honours --load-extension; this build does, and it is what the project's own
# tests run against, so the browser shipped here is the browser the suite
# proves things about.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:20 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    FORMWORK_STATE_DIR=/state \
    FORMWORK_PROFILE_DIR=/profile \
    FORMWORK_CHROME_PROFILE=/state/chrome \
    FORMWORK_CDP_URL=http://localhost:9223 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv \
      xvfb x11vnc openbox websockify novnc x11-utils \
      curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    # Xvfb puts its socket here and cannot create the directory as a non-root
    # user, which it reports as simply never having started.
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# tectonic: a single binary that fetches what a document needs on first use,
# which is the only LaTeX that installs sanely in a container.
ARG TECTONIC_VERSION=0.15.0
RUN curl -fsSL -o /tmp/tectonic.tar.gz \
      "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-gnu.tar.gz" \
    && tar xzf /tmp/tectonic.tar.gz -C /usr/local/bin tectonic \
    && rm /tmp/tectonic.tar.gz \
    && chmod 755 /usr/local/bin/tectonic

WORKDIR /app

COPY server/requirements.txt server/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r server/requirements.txt
ENV PATH="/opt/venv/bin:${PATH}"

COPY package.json package-lock.json ./
RUN npm ci --omit=optional \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY extension/ extension/
COPY server/ server/
COPY tools/ tools/
COPY docker/ docker/
COPY LICENSE ./LICENSE
COPY licenses/ licenses/
RUN install -m 0755 docker/entrypoint.sh /usr/local/bin/formwork-entrypoint

# Warm tectonic's package cache during the build, so the first tailored résumé
# is fast rather than a two-minute download nobody was warned about.
RUN HOME=/home/node PYTHONPATH=/app/server python docker/warm-tex.py \
    && rm -rf /state/*

RUN mkdir -p /state /profile \
    && chown -R node:node /app /state /profile /ms-playwright /home/node

USER node
ENV HOME=/home/node

# 9113 the dashboard, 9112 the view of the browser. The debugging port is
# deliberately not here: it is bound to localhost inside the container, and
# publishing it would hand anyone on the network the browser.
EXPOSE 9113 9112

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS http://localhost:9113/api/widget >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/formwork-entrypoint"]

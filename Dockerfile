# The world server.
#
# One process that ticks one world, talks WebSocket on /ws and answers
# /health on the same port. It does not serve the client: in development Vite
# does that, and in production a reverse proxy puts the static bundle and this
# socket on one hostname (docs/deploy/README.md).
#
# Upstream's image built the client, nginx and supervisor into one container to
# run a match server that no longer exists. Nothing of it survives here.

FROM node:24-slim AS deps
WORKDIR /usr/src/app
ENV HUSKY=0
ENV NPM_CONFIG_IGNORE_SCRIPTS=1
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Map data, trimmed twice.
#
# resources/maps is 511 MB across ~120 maps, and this image hosts one world on
# one of them. So: keep only the maps named in WORLD_MAPS, and within those
# only the two files the server reads — the manifest, and map4x.bin, which the
# province partition is derived from. The full-resolution map.bin, the 16x
# preview and the thumbnails are the client's business.
#
# Pruning in a stage that is thrown away keeps the rest out of the image, not
# merely out of its last layer. If MAP_ID names a map that was not built in,
# the server says so at startup and lists what it has.
FROM node:24-slim AS maps
ARG WORLD_MAPS=europe
WORKDIR /maps
COPY resources/maps ./
RUN for map in *; do \
      case " $WORLD_MAPS " in *" $map "*) ;; *) rm -rf "$map" ;; esac; \
    done && \
    find . -type f \
      \( -name 'map.bin' -o -name 'map16x.bin' -o -name 'thumbnail.webp' \) \
      -delete

FROM node:24-slim
WORKDIR /usr/src/app
ENV NODE_ENV=production

COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY package*.json tsconfig.json ./
# Only the two halves the server actually is. src/client is the renderer and
# has no business in a server image; copying it would also drag the quarantine
# along.
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY drizzle ./drizzle
COPY --from=maps /maps ./resources/maps

ARG GIT_COMMIT=unknown
ENV GIT_COMMIT="$GIT_COMMIT"

EXPOSE 3000

# node, not npm: npm would sit between the container and the process as an
# extra PID, and signals would have to be forwarded by hand. The world needs to
# see SIGTERM itself to stop its loop and close its lock cleanly — and it needs
# to be the thing `docker kill` kills when the gate says to kill it.
CMD ["node", "--import", "tsx", "src/server/Main.ts"]

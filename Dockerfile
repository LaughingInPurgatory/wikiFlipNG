# WikiFlip NG — Node.js + SQLite (no native build step, no web server in front)
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    WIKIFLIP_DB=/app/data/wiki.db

WORKDIR /app

# su-exec: entrypoint starts as root to fix volume ownership, then drops to node
RUN apk add --no-cache su-exec \
  && mkdir -p /app/data \
  && chown -R node:node /app/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO /dev/null http://127.0.0.1:3000/ || exit 1

# Run as root so the entrypoint can chown a fresh volume; it re-execs as node.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]

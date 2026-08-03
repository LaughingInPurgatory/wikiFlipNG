# WikiFlip NG — Node.js + SQLite (no native build step, no web server in front)
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    WIKIFLIP_DB=/app/data/wiki.db

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

# The database is the only thing the app writes, and it lives on a volume
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO /dev/null http://127.0.0.1:3000/ || exit 1

CMD ["node", "server.js"]

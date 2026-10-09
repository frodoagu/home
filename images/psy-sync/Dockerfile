# syntax=docker/dockerfile:1

# psy.agu.com.ar cloud save. No dependencies beyond Bun itself (bun:sqlite,
# WebCrypto), so the image is the runtime plus src/.
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
# The data volume (SQLite + session key) is mounted at /data. Created here,
# owned by `bun`, so a fresh volume inherits the owner.
RUN mkdir /data && chown bun:bun /data
USER bun
ENV DATA_DIR=/data PORT=8787
EXPOSE 8787
CMD ["bun", "src/server.js"]

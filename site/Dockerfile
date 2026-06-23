# syntax=docker/dockerfile:1

# ---- build stage: compile the Vite SPA to static assets ----
FROM node:22-alpine AS build
WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install

COPY . .
RUN npm run build

# ---- runtime stage: nginx serving the built assets ----
# The nginx-spa Helm chart mounts its own /etc/nginx/conf.d/default.conf
# (SPA fallback, caching, /healthz), so this image only ships the files.
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

# Multi-stage build. Node's built-in node:sqlite (Node >=22.5) is used for
# persistence instead of better-sqlite3 deliberately — no native compiler
# toolchain needed in either stage, which is exactly the friction that broke
# a plain `npm install` on Windows without Visual Studio Build Tools during
# this project's own development (see spikes/FINDINGS.md's package choices).

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

EXPOSE 8787
CMD ["node", "dist/server.js"]

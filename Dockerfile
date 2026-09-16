# Multi-stage build. Node's built-in node:sqlite (Node >=22.5) is used for
# persistence instead of better-sqlite3 deliberately — no native compiler
# toolchain needed in either stage, which is exactly the friction that broke
# a plain `npm install` on Windows without Visual Studio Build Tools during
# this project's own development (see spikes/FINDINGS.md's package choices).

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# package-lock.json lacks the "libc" field for @anthropic-ai's platform binaries
# (npm doesn't record it from the registry), so npm ci installs both the glibc
# and musl native CLI binaries (~400MB combined) even though alpine only ever
# uses the musl one. Prune the unused glibc build in the same layer as the
# install so its bytes never end up in the final image.
RUN npm ci --omit=dev && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64
COPY --from=builder /app/dist ./dist

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

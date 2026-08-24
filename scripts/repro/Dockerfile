FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm --quiet install --omit=dev --no-audit --no-fund && npm --quiet install --no-save tsx@^4

COPY tsconfig.json ./
COPY src ./src
COPY scripts/repro ./scripts/repro

USER node

FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src/ src/
COPY forwarder.ts ./
RUN npx tsc

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY --from=builder /app/dist/ dist/
ENV NODE_ENV=production
ENV FORWARDER_PORT=3128
EXPOSE 3128
CMD ["node", "dist/forwarder.js"]

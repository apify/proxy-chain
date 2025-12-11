ARG NODE_IMAGE=node:18.20.8-bookworm
FROM ${NODE_IMAGE}

RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /home/node

COPY --chown=node:node package*.json ./
RUN npm --quiet set progress=false && npm install --no-optional
COPY --chown=node:node . .

USER node

ENTRYPOINT [ "npm", "test", "--" ]

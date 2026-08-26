ARG NODE_IMAGE=node:20.19.6-bookworm
ARG BUN_IMAGE=oven/bun:1-debian

FROM ${BUN_IMAGE} AS bun
FROM ${NODE_IMAGE}

# Bun is an alternative runtime for the same test suite (`test:bun*` scripts).
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /home/node

RUN corepack enable

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY --chown=node:node . .

USER node

# Any package.json script can be selected, e.g. `docker run <image> test:bun`.
ENTRYPOINT [ "pnpm", "run" ]
CMD [ "test" ]

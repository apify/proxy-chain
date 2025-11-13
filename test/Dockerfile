FROM node:18.20.8-bookworm@sha256:c6ae79e38498325db67193d391e6ec1d224d96c693a8a4d943498556716d3783

RUN apt-get update && apt-get install -y --no-install-recommends chromium=142.0.7444.134-1~deb12u1 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /home/node

COPY .. .

RUN npm --quiet set progress=false \
    && npm install --no-optional \
    && echo "Installed NPM packages:" \
    && npm list || true \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

CMD ["npm", "test"]

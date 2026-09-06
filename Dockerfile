FROM node:22-bookworm-slim

# Keep the Node/native allocators within Render Free's 512 MB memory budget.
ENV NODE_OPTIONS=--max-old-space-size=128
ENV MALLOC_ARENA_MAX=2

# Poppler converts Looker Studio's scheduled PDF into WhatsApp-ready PNG pages.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates dumb-init poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
USER node

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]

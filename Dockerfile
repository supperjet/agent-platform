FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/agent-core/package.json packages/agent-core/package.json
COPY packages/agent-server/package.json packages/agent-server/package.json
COPY packages/agent-client/package.json packages/agent-client/package.json
RUN npm ci

COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages

CMD ["npm", "run", "dev:server"]

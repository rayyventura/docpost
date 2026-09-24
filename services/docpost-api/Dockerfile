FROM node:22-slim AS base
WORKDIR /app

# Copy workspace config
COPY package.json package-lock.json* turbo.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/docpost-api/package.json ./services/docpost-api/

# Install dependencies
RUN npm install --workspace=@docpost/docpost-api --workspace=@docpost/shared --include-workspace-root

# Copy source
COPY packages/shared/ ./packages/shared/
COPY services/docpost-api/ ./services/docpost-api/

# Build shared first, then service
RUN npm run build --workspace=@docpost/shared
RUN npm run build --workspace=@docpost/docpost-api

EXPOSE 3003
CMD ["node", "services/docpost-api/dist/index.js"]

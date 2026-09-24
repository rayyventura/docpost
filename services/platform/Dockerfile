FROM node:22-slim AS base
WORKDIR /app

# Copy workspace config
COPY package.json package-lock.json* turbo.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/platform/package.json ./services/platform/

# Install dependencies
RUN npm install --workspace=@docpost/platform --workspace=@docpost/shared --include-workspace-root

# Copy source
COPY packages/shared/ ./packages/shared/
COPY services/platform/ ./services/platform/

# Build shared first, then service
RUN npm run build --workspace=@docpost/shared
RUN npm run build --workspace=@docpost/platform

EXPOSE 3002
CMD ["node", "services/platform/dist/index.js"]

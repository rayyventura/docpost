FROM node:22-slim AS base
WORKDIR /app

# Copy workspace config
COPY package.json package-lock.json* turbo.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/auth/package.json ./services/auth/

# Install dependencies
RUN npm install --workspace=@docpost/auth --workspace=@docpost/shared --include-workspace-root

# Copy source
COPY packages/shared/ ./packages/shared/
COPY services/auth/ ./services/auth/

# Build shared first, then service
RUN npm run build --workspace=@docpost/shared
RUN npm run build --workspace=@docpost/auth

EXPOSE 3001
CMD ["node", "services/auth/dist/index.js"]

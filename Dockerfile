FROM node:22-alpine AS base

# Install build dependencies for native modules + Playwright
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Set Playwright to use system Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --production && npm cache clean --force

# Copy application source
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S aatman && \
    adduser -u 1001 -S aatman -G aatman && \
    mkdir -p /data/workspace /data/logs /data/skills && \
    chown -R aatman:aatman /app /data

# Switch to non-root user
USER aatman

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)"

ENTRYPOINT ["node", "src/index.js"]

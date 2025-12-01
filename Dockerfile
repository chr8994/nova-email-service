FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./

# Install production dependencies
RUN yarn install --production --frozen-lockfile

# Copy built application
COPY dist ./dist

# Run service (default to monolithic mode)
CMD ["node", "dist/index.js"]

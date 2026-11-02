# Build stage: compile TypeScript.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Web stage: build the web app to static files.
FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

# Runtime stage: production dependencies, compiled code, the test console and the web app.
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
COPY --from=web /app/web/dist ./web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/v1/health/ready || exit 1
CMD ["node", "dist/server.js"]

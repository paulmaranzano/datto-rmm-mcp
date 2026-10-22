# Built in-cloud via `az acr build`. Runs the stateless Streamable HTTP server on :3000.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3000 \
    DATTO_MCP_READONLY=true
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
USER node
HEALTHCHECK CMD wget -q --spider http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/index.js"]

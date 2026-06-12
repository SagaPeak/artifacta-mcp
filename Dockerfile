# Builds the TypeScript implementation of the Artifacta MCP server.
# The server starts without an API key and answers initialize/tools/list;
# auth is checked on the first tool call. Supply ARTIFACTA_API_KEY at run
# time for real use:
#   docker run -e ARTIFACTA_API_KEY=ak_live_... -i artifacta-mcp

FROM node:22-alpine AS build
WORKDIR /app
COPY typescript/package.json typescript/package-lock.json ./
RUN npm ci
COPY typescript/tsconfig.json ./
COPY typescript/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY typescript/package.json ./
ENTRYPOINT ["node", "dist/cli.js"]

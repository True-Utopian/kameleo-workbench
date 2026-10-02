FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN groupadd -g 1001 workbench && useradd -u 1001 -g workbench -m workbench
WORKDIR /app
COPY --from=build --chown=1001:1001 /app/package*.json ./
COPY --from=build --chown=1001:1001 /app/node_modules ./node_modules
COPY --from=build --chown=1001:1001 /app/dist ./dist
COPY --chown=1001:1001 public ./public
COPY --chown=1001:1001 automations ./automations
COPY --chown=1001:1001 flows ./flows
COPY --chown=1001:1001 schemas ./schemas
COPY --chown=1001:1001 scripts ./scripts
RUN mkdir -p /state /exports && chown 1001:1001 /state /exports
USER 1001:1001
ENV HOST=0.0.0.0 PORT=3180 WORKBENCH_DATA_DIR=/state EXPORT_DIR=/exports
EXPOSE 3180
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3180/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/cli.js", "serve"]

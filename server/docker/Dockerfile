# The HopDesk server: account API and rendezvous.
#
# Node 24 for `node:sqlite`, which is why there is no database service and no
# native module to compile. Only the three workspaces the server needs are
# copied in, so the image does not carry the desktop app or Electron.
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/crypto/package.json packages/crypto/
COPY packages/protocol/package.json packages/protocol/
COPY server/package.json server/
# --ignore-scripts: nothing in this dependency set needs a build step, and a
# lifecycle script from a dependency has no business running here.
RUN npm ci --ignore-scripts --workspace @hopdesk/server --include-workspace-root

COPY packages/crypto packages/crypto
COPY packages/protocol packages/protocol
COPY server server
RUN npm -w @hopdesk/crypto run build \
 && npm -w @hopdesk/protocol run build \
 && npm -w @hopdesk/server run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOPDESK_DATA_DIR=/var/lib/hopdesk HOPDESK_HOST=0.0.0.0 HOPDESK_PORT=8787

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/crypto/package.json ./packages/crypto/package.json
COPY --from=build /app/packages/crypto/dist ./packages/crypto/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist

RUN mkdir -p /var/lib/hopdesk && chown -R node:node /var/lib/hopdesk
USER node
EXPOSE 8787
# The account database lives here; keep it on a volume.
VOLUME ["/var/lib/hopdesk"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HOPDESK_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]

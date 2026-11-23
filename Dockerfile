FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json start.mjs server.mjs render-server.mjs render-legacy.mjs categories.mjs catalog.mjs ./
COPY --chown=node:node public ./public
RUN mkdir /app/data && chown node:node /app/data
ENV PORT=3000 NODE_ENV=production
USER node
VOLUME ["/app/data"]
CMD ["node", "start.mjs"]

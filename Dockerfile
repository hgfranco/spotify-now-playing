FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY server.js logo.png ./

RUN mkdir -p /var/data && chown node:node /var/data

USER node

EXPOSE 3000

CMD ["node", "server.js"]
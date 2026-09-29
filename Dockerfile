# The Klahompton game server (the game page itself is hosted on Netlify).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

# install only what the server needs (it pulls in the shared islands/rules package from this repo)
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --workspace server --omit=dev --no-audit --no-fund

COPY shared/ shared/
COPY server/src/ server/src/

EXPOSE 8080
CMD ["node", "server/src/index.js"]

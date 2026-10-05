FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs door.mjs token.mjs credits.mjs wallet-mock.mjs wallet-nwc.mjs ./
ENV L402_PORT=3503 L402_BIND=0.0.0.0 L402_HOME=/data
VOLUME /data
EXPOSE 3503
CMD ["node", "server.mjs"]

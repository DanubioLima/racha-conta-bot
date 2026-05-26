FROM node:24-alpine

WORKDIR /app

# Install dependencies (camada cacheável). better-sqlite3 é módulo nativo e não
# tem prebuild pra musl/Alpine, então compila do source: o toolchain entra como
# pacote virtual e sai logo após o build, mantendo a imagem enxuta (o binário
# .node compilado permanece em node_modules).
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps

# Copy source
COPY . .

# Volume mount-point pro data dir; Dokploy mapeia volume persistente aqui
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["npm", "start"]

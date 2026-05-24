FROM node:24-alpine

WORKDIR /app

# Install dependencies (camada cacheável)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Volume mount-point pro data dir; Dokploy mapeia volume persistente aqui
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["npm", "start"]

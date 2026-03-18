FROM node:24-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# SQLite data lives on a persistent volume mounted at /app/data
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["npm", "start"]

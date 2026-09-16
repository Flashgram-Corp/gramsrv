FROM node:22-alpine
WORKDIR /opt/grammystore
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY db/migrate.js ./db/migrate.js
COPY db/migrations ./db/migrations
CMD ["npm", "start"]

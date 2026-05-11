FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install
COPY . .


CMD ["sh", "-c", "npx wait-port postgres_db:5432 && npm run dev"]
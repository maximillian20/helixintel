FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV SOURCE_DB_PATH=/var/data/source-store.sqlite
EXPOSE 3001
CMD ["npm", "start"]

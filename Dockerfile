FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000
CMD ["node", "src/server.mjs"]

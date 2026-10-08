FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=10000

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

EXPOSE 10000
CMD ["npm", "start"]

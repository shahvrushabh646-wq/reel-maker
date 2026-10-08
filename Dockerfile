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

# Render uses the Docker CMD and requires the HTTP process to bind 0.0.0.0:$PORT.
CMD ["npm", "start"]

# Container-level readiness check; Render also uses /health from render.yaml.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

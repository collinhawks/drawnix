FROM node:20 AS builder 

WORKDIR /builder

COPY . /builder

RUN npm install \
    && npm run build 

FROM node:20-slim

WORKDIR /app

ENV DRAWNIX_DATA_DIR=/data
ENV DRAWNIX_PORT=3000
ENV DRAWNIX_HOST=0.0.0.0

COPY --from=builder /builder/dist/apps/web ./dist/apps/web
COPY --from=builder /builder/server ./server

VOLUME ["/data"]

EXPOSE 3000

CMD ["node", "server/index.js"]
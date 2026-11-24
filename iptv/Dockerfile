FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data TRUST_PROXY=1 IPTV_BLOCK_PRIVATE=1
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server.js"]

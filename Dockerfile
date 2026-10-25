FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY client ./client
# Signatures, contacts and send-attempt records live here. Mount a volume.
RUN mkdir -p /data && chown node:node /data
ENV TU_MAIL_DATA_DIR=/data
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "require('http').get({host:'127.0.0.1',port:3210,path:'/api/health',headers:{host:new URL(process.env.PUBLIC_URL||'http://localhost:3210').host}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server/server.js"]

FROM node:22-slim
WORKDIR /app
COPY package.json server.js assets.js ./
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]

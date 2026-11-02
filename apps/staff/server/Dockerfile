FROM node:22-alpine
WORKDIR /app
COPY . .
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
# The database lives here; mount a persistent disk/volume at /data.
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["npm", "start"]

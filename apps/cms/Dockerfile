FROM node:20-alpine
RUN apk add --no-cache vips-dev build-base python3
WORKDIR /opt/app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
RUN mkdir -p public/uploads && npm run build
EXPOSE 1337
CMD ["npm", "run", "start"]

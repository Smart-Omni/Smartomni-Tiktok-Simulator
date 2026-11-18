# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY api ./api
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine
# The official image renders /etc/nginx/templates/*.template with the container environment at start.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

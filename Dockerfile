FROM node:22.23.4-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/.local/objects && chown -R node:node /app/.local
USER node
ENV HOST=0.0.0.0
EXPOSE 4317 4318
CMD ["npm", "run", "dev"]

FROM denoland/deno:latest

WORKDIR /app

# Copie exclusive des composants requis pour le Bot
COPY packages/shared/ packages/shared/
COPY services/bot/ services/bot/

WORKDIR /app/services/bot

# Pré-cache des dépendances Deno
RUN deno cache src/main.ts

CMD ["deno", "run", "-A", "src/main.ts"]

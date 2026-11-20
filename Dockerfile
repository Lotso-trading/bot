# syntax=docker/dockerfile:1
FROM denoland/deno:latest

WORKDIR /app

# Copie exclusive des composants requis pour le Bot
COPY packages/shared/ packages/shared/
COPY services/bot/ services/bot/

WORKDIR /app/services/bot

# Pré-cache des dépendances Deno via BuildKit secret (aucun token persisté dans les layers)
RUN --mount=type=secret,id=github_token \
    sh -ec ' \
        trap "rm -f \"$HOME/.npmrc\"" EXIT; \
        TOKEN="$(tr -d "\r\n" < /run/secrets/github_token 2>/dev/null || true)"; \
        if [ -z "$TOKEN" ]; then \
            echo "ERROR: Secret BuildKit github_token vide. Définissez GITHUB_TOKEN (scope read:packages) dans .env ou votre shell." >&2; \
            exit 1; \
        fi; \
        printf "@lotso-trading:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=%s\n" "$TOKEN" > "$HOME/.npmrc"; \
        deno cache --min-dep-age=0 src/main.ts \
    '

CMD ["deno", "run", "-A", "src/main.ts"]

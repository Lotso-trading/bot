import { BotRunner } from "./interfaces/bot-runner.ts";

export async function bootstrapBot(): Promise<void> {
  const runner = new BotRunner();
  await runner.start();
}

if (import.meta.main) {
  bootstrapBot().catch((err: unknown) => {
    console.error("[Bot] Erreur fatale au démarrage:", err);
  });
}

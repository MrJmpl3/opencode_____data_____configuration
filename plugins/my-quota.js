// my-quota — Plugin hello world para OpenCode
// Documentacion: https://opencode.ai/docs/plugins/
// Basado en el patron de https://github.com/slkiser/opencode-quota
//
// Para EVITAR que el LLM se invoque, el hook command.execute.before debe:
//   1. Inyectar la respuesta directamente via SDK (noReply: true)
//   2. LANZAR UN ERROR para cortar el flujo antes de que prompt() se ejecute
//
// Mutar output.parts NO evita el LLM — solo cambia lo que el LLM recibe.
// La unica forma de abortar es lanzar un error desde el hook.

export const MyQuota = async ({ client }) => {
  console.error("[my-quota] Plugin cargado correctamente!");

  return {
    // ── Registrar el comando /quota ──
    config: async (cfg) => {
      if (!cfg.command) cfg.command = {};
      cfg.command["quota"] = {
        template: "Muestra informacion de cuota",
        description: "Muestra cuota actual (plugin de ejemplo my-quota)",
      };
    },

    // ── Interceptar /quota y responder SIN LLM ──
    "command.execute.before": async (input, _output) => {
      if (input.command !== "quota") return;

      // 1. Inyectar el mensaje directamente en la sesion (no pasa por LLM)
      await client.session.prompt({
        path: { id: input.sessionID },
        body: {
          noReply: true,
          parts: [
            {
              type: "text",
              text: [
                "Hello from my-quota!",
                "",
                "Plugin funcionando correctamente.",
                "Documentacion: https://opencode.ai/docs/plugins/",
              ].join("\n"),
              ignored: true, // visible al user, no entra al contexto del LLM
            },
          ],
        },
      });

      // 2. Mostrar toast como bonus (side-effect, sin LLM)
      try {
        await client.tui.showToast({
          body: {
            message: "/quota — Plugin hello world respondio sin LLM",
            variant: "success",
          },
        });
      } catch {
        // Toast puede fallar si no hay TUI (CLI/web mode)
      }

      // 3. ❗ Lanzar error para cortar el flujo.
      //    Si este hook resuelve (no lanza), OpenCode ejecuta prompt()
      //    y el LLM se invoca. Lanzar es la UNICA forma de evitarlo.
      throw new Error("__QUOTA_COMMAND_HANDLED__");
    },
  };
};

Fork de `gripebomb/pi-discord-activity` para que la presencia de Discord soporte **varias sesiones de pi abiertas a la vez**: una sola presencia, un solo tiempo (el de la sesión abierta hace más), el estado/modelo de la sesión en primer plano y un resumen con los agentes abiertos y los subagentes vivos. Se mantiene el upstream como referencia permanente.

## Specs

- **S1** — "yo tengo abiertos varios agentes al mismo tiempo uno con mas tiempo que otro" → varias sesiones de pi activas deben convivir en una sola presencia.
- **S2** — "debe soportar un solo tiempo por el mas abierto" → la presencia muestra **un único tiempo**, el de la sesión abierta desde más temprano (`min(startedAt)` de las vivas).
- **S3** — "cambiar segun el agente que este en primer plano" → el estado y el modelo mostrados son los de la sesión **en primer plano** (la que el usuario envió por última vez, con desempate por actividad más reciente).
- **S4** — "junto con un resumen de todos los agentes abiertos y los subagentes activos lanzados en vivo" → la presencia incluye `N agentes · M subagentes`, contados de datos reales.
- **S5** — "hay que hacer fork a ese plugin, siempre revisar mainstream para que no nos falte ninguna nueva funcion del original pero darle soporte a esto" → el trabajo vive en el fork (`loonbac/Pi-Discord-Activity`) con `upstream` configurado y un procedimiento documentado de sincronización.
- **S6** — Cerrar **una** sesión no debe borrar la presencia de las demás (defecto verificado: `clearPresence()` sin `sessionId` limpia Discord entero).
- **S7** — Ningún número se inventa: los subagentes salen de los task records reales (`~/.pi/agent/gentle-agents/tasks/*.json`, `status: "running"`); si no hay, el contador es 0 y no se muestra.

## Diagnóstico (verificado en el código, antes de tocar nada)

| # | Defecto | Archivo | Efecto observado |
| --- | --- | --- | --- |
| 1 | `setPresence(payload)` aplica el último payload recibido | `src/helper/index.ts` (`createPresenceHandler`) | La presencia muestra la sesión que publicó último |
| 2 | `startTimestamp: payload.startedAt` de esa sesión | `src/helper/discord.ts` (`buildActivity`) | El tiempo salta de sesión en sesión en vez de ser uno solo |
| 3 | `session_shutdown` → `POST /clear` sin `sessionId` | `src/extension/index.ts` + `src/helper/server.ts` | Cerrar una sesión borra la presencia de todas |
| 4 | `isEquivalent()` compara `state/model/provider/project`, no `startedAt` | `src/helper/index.ts` | Un cambio que sólo mueve el tiempo no se reenvía: reloj anclado a una sesión vieja |

## Tasks

- **T1** (`shared/aggregate.ts`, tests `tests/aggregate.test.ts`) — `aggregatePresence()` puro: selecciona primer plano por `lastPromptAt` (empate por `lastSeen`), tiempo = `min(startedAt)`, estado = prioridad `editing > tooling > thinking > error > starting > idle`, resumen `{agents, subagents}`. Commit `feat(presence)`. → S1, S2, S3, S4, S7
- **T2** (`helper/index.ts`, `helper/server.ts`) — registro de sesiones vivas por `sessionId` con `lastSeen`, `POST /retire` con `sessionId` (y `/clear` sin id sigue limpiando todo por compatibilidad), poda por TTL, reenvío cuando cambia el **agregado** (corrige el defecto 4). → S1, S2, S6
- **T3** (`helper/subagents.ts`) — lector de task records de subagentes vivos con ruta configurable (`PI_PRESENCE_AGENTS_DIR`), refresco periódico; 0 subagentes si no hay. → S4, S7
- **T4** (`extension/index.ts`) — `session_shutdown` retira **su** sesión (no `/clear` global) y latido periódico para que una sesión abierta e inactiva siga contada. → S1, S2, S6
- **T5** (`helper/discord.ts`, instalación) — `details: N agentes · M subagentes`, `state: modelo • estado` del primer plano, `startTimestamp: min(startedAt)`; instalar en pi por ruta local, reiniciar el helper y verificación end-to-end con sesiones sintéticas. → S1, S2, S3, S4
- **T6** (documentación + `scripts/sync-upstream.sh`) — procedimiento para no perder funciones del upstream y nota en el README. → S5

## Log

- **L1** (pedido original, verbatim): "mientras estas esperando a realizar todo eso quiero que configures el plugin de presence de discord, tengo un problema y es que sale segun que sesion tenga abierta, quiero que tenga soporte tambien a mis multiples agentes porque yo tengo abiertos varios agentes al mismo tiempo uno con mas tiempo que otro asi que debe soportar un solo tiempo por el mas abierto y todo eso"
- **L2** (decisión de ubicación, verbatim): "hay que hacer fork a ese plugin, siempre revisar mainstream para que no nos falte ninguna nueva funcion del original pero darle soporte a esto te parece"
- **L3** (decisión de presentación, verbatim): "cambiar segun el agente que este en primer plano junto con un resumen de todos los agentes abiertos y los subagentes activos lanzados en vivo"
- **L4** (evidencia): fork `loonbac/Pi-Discord-Activity` clonado en `/home/loonbac/Proyectos/pi-discord-activity`, `origin` + `upstream` (gripebomb) configurados y **al día** (24 commits, `HEAD..upstream/main` vacío). El repo del fork tiene `tests/` y `.github/workflows/ci.yml` (node 20/22) que el paquete npm no incluía.
- **L5** (evidencia de la fuente de subagentes): `~/.pi/agent/gentle-agents/tasks/*.json` expone `status: "running"` con `agent`, `parentSessionId`, `createdAt`; conteo en vivo mientras se ejecuta un subagente (1 running observado el 2026-10-16T03:58). No se inventa dato.
- **L6** (criterio de "primer plano", pendiente de confirmación del owner): no existe evento de foco en la extensión, así que el primer plano se define como la sesión con `agent_start` más reciente (`lastPromptAt`), con desempate por `lastSeen`. Es observable y ajustable sin tocar el protocolo.

import api, { route } from "@forge/api";
import { kvs } from "@forge/kvs";
import Resolver from '@forge/resolver';

// ─────────────────────────────────────────────────────────
// [UI] RESOLVER: Puente entre frontend y backend
// ─────────────────────────────────────────────────────────
const resolver = new Resolver();

resolver.define('generateToken', async (req) => {
  const accountId = req.context.accountId;
  const token = Math.random().toString(36).substring(2, 8).toUpperCase();
  await kvs.set(`pending_token_${token}`, accountId);
  return token;
});

export const pageResolver = resolver.getDefinitions();

// ─────────────────────────────────────────────────────────
// [API TELEGRAM] HELPER: ENVÍO DE MENSAJES DINÁMICOS
// ─────────────────────────────────────────────────────────
async function sendTelegramMessage(chatId, text, inlineKeyboard = null) {
  const token = process.env.TELEGRAM_TOKEN;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  let payload = { chat_id: chatId, text: text, parse_mode: "Markdown" };

  if (inlineKeyboard) {
    payload.reply_markup = { inline_keyboard: inlineKeyboard };
  }

  await api.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// ─────────────────────────────────────────────────────────
// [API JIRA] HELPERS: OBTENER DATOS Y TRANSICIONES
// ─────────────────────────────────────────────────────────
async function getIssueData(issueKey) {
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,status`);
    if (res.status === 200) {
      const data = await res.json();
      return {
        summary: data.fields?.summary || "Sin título",
        status: data.fields?.status?.name || "Desconocido"
      };
    }
    return { summary: "Sin título", status: "Desconocido" };
  } catch (error) {
    return { summary: "Sin título", status: "Desconocido" };
  }
}

async function getAvailableTransitions(issueKey) {
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/transitions`, {
      headers: { 'Accept': 'application/json' }
    });
    if (res.status === 200) {
      const data = await res.json();
      return data.transitions || [];
    }
    return [];
  } catch (error) {
    return [];
  }
}

async function getOpenSubtasksCount(issueKey) {
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=subtasks`);
    if (res.status !== 200) return 0;
    
    const data = await res.json();
    const subtasks = data.fields?.subtasks || [];
    
    // Filtramos solo las que NO están terminadas
    const openSubtasks = subtasks.filter(sub => {
      const statusName = sub.fields?.status?.name?.toUpperCase() || "";
      return statusName !== "LISTO" && statusName !== "DONE";
    });
    
    return openSubtasks.length;
  } catch (error) {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────
// [API JIRA] HELPER: TRANSICIÓN DE ESTADO
// ─────────────────────────────────────────────────────────
async function transitionIssue(issueKey, targetStatusName) {
  const transitions = await getAvailableTransitions(issueKey);
  const transition = transitions.find(
    t => t.name.toLowerCase() === targetStatusName.toLowerCase() || 
         t.to.name.toLowerCase() === targetStatusName.toLowerCase()
  );

  if (!transition) return false;

  const postResponse = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/transitions`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ transition: { id: transition.id } })
  });

  return postResponse.status === 204;
}

// ─────────────────────────────────────────────────────────
// [API JIRA] HELPER: BARRIDO AUTOMÁTICO DE SUBTAREAS
// ─────────────────────────────────────────────────────────
async function sweepSubtasks(parentIssueKey) {
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${parentIssueKey}?fields=subtasks`);
    if (res.status !== 200) return 0;
    
    const data = await res.json();
    const subtasks = data.fields?.subtasks || [];
    let closedCount = 0;

    for (const sub of subtasks) {
      const success = await transitionIssue(sub.key, "LISTO");
      if (success) {
        await agregarComentarioFijo(sub.key, "🧹 Subtarea cerrada automáticamente por barrido de la tarea padre (vía Telegram).");
        closedCount++;
      }
    }
    return closedCount;
  } catch (error) {
    console.error("Error ejecutando el barrido de subtareas:", error);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────
// [WEBHOOKS] 1. EVENTO JIRA: ASIGNACIÓN DE TICKET
// ─────────────────────────────────────────────────────────
export async function runTrigger(event, context) {
  const issueKey = event.issue.key;
  
  const issueRes = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`);
  const issueData = await issueRes.json();
  const assignee = issueData.fields?.assignee;
  const summary = issueData.fields?.summary || "Sin título"; 

  if (!assignee) return;

  const accountId = assignee.accountId;
  const asignadoA = assignee.displayName || "Equipo"; 

  const chatId = await kvs.get(`tg_chat_${accountId}`);
  if (!chatId) return; 

  const defaultKeyboard = [
    [ { text: "🚀 Con avances", callback_data: `TG_AVANCE_${issueKey}` }, { text: "🛑 Sin avances", callback_data: `TG_SINAVANCE_${issueKey}` } ],
    [ { text: "✅ Terminada", callback_data: `TG_DONE_${issueKey}` } ]
  ];

  const mensaje = `Hola *${asignadoA}*. Se te ha asignado la tarea:\n\n📌 *${issueKey} - ${summary}*\n\n¿Cuál es el estado actual?`;
  await sendTelegramMessage(chatId, mensaje, defaultKeyboard);
}

// ─────────────────────────────────────────────────────────
// [WEBHOOKS] 2. EVENTO EXTERNO: RESPUESTAS DE TELEGRAM
// ─────────────────────────────────────────────────────────
export async function runWebtrigger(request) {
  const body = JSON.parse(request.body);

  // === A. MANEJO DE TEXTO LIBRE Y COMANDOS ===
  if (body.message && body.message.text) {
    const chatId = body.message.chat.id;
    const text = body.message.text.trim();

    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      if (parts.length < 2 || parts[1].includes('@')) {
        await sendTelegramMessage(chatId, `⚠️ *Registro denegado.*\nPor favor, genera el enlace desde Jira.`);
        return { body: "OK", statusCode: 200 };
      }
      const tokenIngresado = parts[1].toUpperCase(); 
      const accountId = await kvs.get(`pending_token_${tokenIngresado}`);

      if (!accountId) {
        await sendTelegramMessage(chatId, `❌ *Token inválido o expirado.* Vuelve a generar el enlace desde Jira.`);
        return { body: "OK", statusCode: 200 };
      }

      await kvs.set(`tg_chat_${accountId}`, chatId);
      await kvs.delete(`pending_token_${tokenIngresado}`);

      const userRes = await api.asApp().requestJira(route`/rest/api/3/user?accountId=${accountId}`);
      const userData = await userRes.json();
      const displayName = userData.displayName || "Usuario";

      await sendTelegramMessage(chatId, `✅ ¡Registro exitoso, *${displayName}*!\nRecibirás tus asignaciones aquí.`);
      return { body: "OK", statusCode: 200 };
    }

    if (text.toLowerCase() === 'cancelar') {
      await kvs.delete(`chat_state_${chatId}`);
      await sendTelegramMessage(chatId, `🚫 Acción cancelada. El bot está listo para nuevas instrucciones.`);
      return { body: "OK", statusCode: 200 };
    }

    // MEMORIA A CORTO PLAZO (PROCESAMIENTO DE TEXTO)
    const chatState = await kvs.get(`chat_state_${chatId}`);
    if (chatState) {
      const { issueKey, action } = chatState;
      const issueDataAPI = await getIssueData(issueKey);
      const currentStatus = issueDataAPI.status.toUpperCase();

      let prefijo = "";
      let statusMessageExtra = "";

      if (action === 'AVANCE') { 
        prefijo = "🚀 *Avance reportado vía Telegram:*\n"; 
        if (currentStatus === 'POR HACER' || currentStatus === 'TO DO') {
          const transitionSuccess = await transitionIssue(issueKey, "EN PROGRESO");
          if (transitionSuccess) statusMessageExtra = `\n🔄 _La tarea fue movida automáticamente a "En Progreso"._`;
        }
      }
      else if (action === 'SINAVANCE') { prefijo = "🛑 *Motivo de retraso (Telegram):*\n"; }

      const comentarioFinal = `${prefijo}${text}`;

      await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: comentarioFinal }] }] }
        })
      });

      await kvs.delete(`chat_state_${chatId}`);
      await sendTelegramMessage(chatId, `✅ Tu comentario ha sido publicado exitosamente en:\n*${issueKey} - ${issueDataAPI.summary}*${statusMessageExtra}`);
      return { body: "OK", statusCode: 200 };
    }

    return { body: "OK", statusCode: 200 };
  }

  // === B. MANEJO DE BOTONES (CALLBACKS) ===
  if (body.callback_query) {
    const callbackData = body.callback_query.data;
    const chatId = body.callback_query.message.chat.id;

    const [source, action, ...issueKeyParts] = callbackData.split('_');
    const issueKey = issueKeyParts.join('_');
    const issueDataAPI = await getIssueData(issueKey); 
    const tituloCompleto = `*${issueKey} - ${issueDataAPI.summary}*`;

    if (source === 'TG') {
      
      // LA MAGIA: RADAR DE TRANSICIONES Y BARRIDO
      if (action === 'DONE') {
        const currentStatus = issueDataAPI.status.toUpperCase();
        const transitions = await getAvailableTransitions(issueKey);
        const transitionNames = transitions.map(t => t.name.toUpperCase());
        
        const isCurrentlyInReview = currentStatus === 'EN REVISIÓN' || currentStatus === 'EN REVISION';
        const canReview = (transitionNames.includes('EN REVISIÓN') || transitionNames.includes('EN REVISION')) && !isCurrentlyInReview;
        const canDone = transitionNames.includes('LISTO') || transitionNames.includes('DONE');

        // 1. Verificación de seguridad: Subtareas abiertas
        const openSubtasksCount = await getOpenSubtasksCount(issueKey);
        
        if (openSubtasksCount > 0) {
          // MODO ADVERTENCIA: Construimos los botones según a dónde puede ir el padre
          let warningKeyboard = [];

          if (canReview && canDone) {
            warningKeyboard.push([ { text: "🔍 Enviar a Revisión y barrer subtareas", callback_data: `TG_SWEEPREVIEW_${issueKey}` } ]);
            warningKeyboard.push([ { text: "🏁 Marcar Listo y barrer subtareas", callback_data: `TG_SWEEPLISTO_${issueKey}` } ]);
          } else if (canReview && !canDone) {
            warningKeyboard.push([ { text: "🔍 Enviar a Revisión y barrer subtareas", callback_data: `TG_SWEEPREVIEW_${issueKey}` } ]);
          } else if (canDone) {
            warningKeyboard.push([ { text: "🧹 Sí, finalizar todo", callback_data: `TG_SWEEPLISTO_${issueKey}` } ]);
          }

          warningKeyboard.push([ { text: "❌ Cancelar", callback_data: `TG_CANCEL_${issueKey}` } ]);

          if (warningKeyboard.length > 1) {
            await sendTelegramMessage(
              chatId, 
              `⚠️ **Atención:** La tarea ${tituloCompleto} tiene **${openSubtasksCount} subtarea(s)** en curso.\n\n¿A dónde deseas enviar la tarea principal mientras cerramos automáticamente las subtareas?`, 
              warningKeyboard
            );
          } else {
            await sendTelegramMessage(chatId, `⚠️ No puedes finalizar ${tituloCompleto} desde su estado actual en Jira. Es posible que primero debas reportar un avance.`);
          }
          return { body: "OK", statusCode: 200 };
        }

        // 2. MODO NORMAL: No hay subtareas abiertas
        if (canReview && canDone) {
          const subMenuKeyboard = [
            [ { text: "🔍 Enviar a Revisión", callback_data: `TG_REVISION_${issueKey}` } ],
            [ { text: "🏁 Marcar como Listo", callback_data: `TG_LISTO_${issueKey}` } ],
            [ { text: "❌ Cancelar", callback_data: `TG_CANCEL_${issueKey}` } ]
          ];
          await sendTelegramMessage(chatId, `La tarea ${tituloCompleto} tiene múltiples caminos de cierre en tu tablero.\n\n¿A dónde deseas enviarla?`, subMenuKeyboard);
        } 
        else if (canReview && !canDone) {
          const transitionSuccess = await transitionIssue(issueKey, "EN REVISIÓN");
          if (transitionSuccess) {
            await agregarComentarioFijo(issueKey, "🔍 Tarea enviada a Revisión vía Telegram.");
            await sendTelegramMessage(chatId, `¡Entendido! Moví el ticket ${tituloCompleto} a "EN REVISIÓN".`);
          }
        } 
        else if (canDone) {
          const transitionSuccess = await transitionIssue(issueKey, "LISTO");
          if (transitionSuccess) {
            await agregarComentarioFijo(issueKey, "✅ Tarea marcada como Terminada vía Telegram.");
            await sendTelegramMessage(chatId, `¡Excelente! Moví el ticket ${tituloCompleto} a "LISTO".`);
          }
        } 
        else {
          await sendTelegramMessage(chatId, `⚠️ No puedes finalizar ${tituloCompleto} desde su estado actual en Jira. Es posible que primero debas reportar un avance.`);
        }
      }
      
      // NUEVAS ACCIONES: BARRIDO Y MOVIMIENTO CONJUNTO
      else if (action === 'SWEEPREVIEW') {
        const transitionSuccess = await transitionIssue(issueKey, "EN REVISIÓN");
        if (transitionSuccess) {
          const subtasksClosed = await sweepSubtasks(issueKey);
          const sweepMsg = subtasksClosed > 0 ? `\n🧹 *Barrido automático:* Se cerraron ${subtasksClosed} subtareas asociadas.` : "";
          await agregarComentarioFijo(issueKey, `🔍 Tarea enviada a Revisión y subtareas finalizadas vía Telegram.${sweepMsg}`);
          await sendTelegramMessage(chatId, `¡Entendido! Moví el ticket ${tituloCompleto} a "EN REVISIÓN".${sweepMsg}`);
        } else {
          await sendTelegramMessage(chatId, `⚠️ Hubo un problema al intentar mover ${tituloCompleto} a Revisión.`);
        }
      }

      else if (action === 'SWEEPLISTO') {
        const transitionSuccess = await transitionIssue(issueKey, "LISTO");
        if (transitionSuccess) {
          const subtasksClosed = await sweepSubtasks(issueKey);
          const sweepMsg = subtasksClosed > 0 ? `\n🧹 *Barrido automático:* Se cerraron ${subtasksClosed} subtareas asociadas.` : "";
          await agregarComentarioFijo(issueKey, `✅ Tarea y subtareas marcadas como Terminadas en bloque vía Telegram.${sweepMsg}`);
          await sendTelegramMessage(chatId, `¡Excelente! Moví el ticket ${tituloCompleto} y sus dependencias a "LISTO".${sweepMsg}`);
        } else {
          await sendTelegramMessage(chatId, `⚠️ Hubo un problema al intentar cerrar ${tituloCompleto} y sus subtareas.`);
        }
      }

      // ACCIONES SECUNDARIAS DEL SUB-MENÚ NORMAL
      else if (action === 'REVISION') {
        const transitionSuccess = await transitionIssue(issueKey, "EN REVISIÓN");
        if (transitionSuccess) {
          await agregarComentarioFijo(issueKey, "🔍 Tarea enviada a Revisión vía Telegram.");
          await sendTelegramMessage(chatId, `¡Entendido! Moví el ticket ${tituloCompleto} a "EN REVISIÓN".`);
        } else {
          await sendTelegramMessage(chatId, `⚠️ Hubo un problema al mover ${tituloCompleto} a "EN REVISIÓN".`);
        }
      }

      else if (action === 'LISTO') {
        const transitionSuccess = await transitionIssue(issueKey, "LISTO");
        if (transitionSuccess) {
          await agregarComentarioFijo(issueKey, "✅ Tarea marcada como Terminada vía Telegram.");
          await sendTelegramMessage(chatId, `¡Excelente! Moví el ticket ${tituloCompleto} a "LISTO".`);
        } else {
          await sendTelegramMessage(chatId, `⚠️ Hubo un problema al mover ${tituloCompleto} a "LISTO".`);
        }
      }

      // ACCIONES DE AVANCES Y BLOQUEOS
      else if (action === 'AVANCE') {
        await kvs.set(`chat_state_${chatId}`, { issueKey, action: 'AVANCE' });
        await sendTelegramMessage(chatId, `📝 Entendido. ¿Qué avances lograste en:\n${tituloCompleto}?\n\nEscríbelo en un mensaje y lo subiré a Jira.\n_(Escribe "cancelar" para abortar)_`);
      } 
      
      else if (action === 'SINAVANCE') {
        await kvs.set(`chat_state_${chatId}`, { issueKey, action: 'SINAVANCE' });
        await sendTelegramMessage(chatId, `🛑 Sin problemas. ¿Cuál es el motivo o bloqueo con:\n${tituloCompleto}?\n\nEscríbelo abajo para dejar el registro. Si necesitas crear un ticket de error, recuerda visitar tu proyecto en Jira.\n\n_(Escribe "cancelar" para abortar)_`);
      }

      else if (action === 'CANCEL') {
        await kvs.delete(`chat_state_${chatId}`);
        await sendTelegramMessage(chatId, `🚫 Acción cancelada.`);
      }

    } 
  }

  return { body: "OK", headers: { "Content-Type": ["application/json"] }, statusCode: 200 };
}

// Pequeño helper interno para no repetir código de comentarios
async function agregarComentarioFijo(issueKey, texto) {
  await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: texto }] }] }
    })
  });
}
import api, { route } from "@forge/api";
import { kvs } from "@forge/kvs";

// ─────────────────────────────────────────────────────────
// HELPER: ENVÍO DE MENSAJES (Módulo Telegram)
// ─────────────────────────────────────────────────────────
async function sendTelegramMessage(chatId, text, issueKey) {
  const token = process.env.TELEGRAM_TOKEN;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text: text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🚀 Con avances", callback_data: `TG_AVANCE_${issueKey}` },
          { text: "🛑 Sin avances", callback_data: `TG_SINAVANCE_${issueKey}` }
        ],
        [
          { text: "✅ Terminada", callback_data: `TG_DONE_${issueKey}` }
        ]
      ]
    }
  };

  await api.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// ─────────────────────────────────────────────────────────
// HELPER: TRANSICIÓN DE ESTADO EN JIRA
// ─────────────────────────────────────────────────────────
async function transitionIssue(issueKey, targetStatusName) {
  const getResponse = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/transitions`, {
    headers: { 'Accept': 'application/json' }
  });
  
  const transitionsData = await getResponse.json();
  const transition = transitionsData.transitions.find(
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
// 1. EVENTO JIRA: Se dispara cuando se asigna un ticket
// ─────────────────────────────────────────────────────────
export async function runTrigger(event, context) {
  const issueKey = event.issue.key;
  
  // 1. Solicitamos la tarea completa a la API para obtener los datos reales (no la versión resumida)
  const issueRes = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`);
  const issueData = await issueRes.json();
  const assignee = issueData.fields?.assignee;

  if (!assignee) {
    console.log(`La tarea ${issueKey} quedó sin asignar.`);
    return;
  }

  // Obtenemos el ID inmutable y el nombre
  const accountId = assignee.accountId;
  const asignadoA = assignee.displayName || "Equipo"; 

  // 2. Buscamos al usuario en la base de datos usando su accountId
  const chatId = await kvs.get(`tg_chat_${accountId}`);

  if (!chatId) {
    console.log(`🛑 El usuario ${asignadoA} no está registrado en el bot de Telegram.`);
    return; 
  }

  const mensaje = `Hola ${asignadoA}. Se te ha asignado la tarea ${issueKey}. ¿Cuál es el estado actual?`;
  console.log(`Enviando ping para ${issueKey} al usuario registrado: ${asignadoA}`);
  await sendTelegramMessage(chatId, mensaje, issueKey);
}

// ─────────────────────────────────────────────────────────
// 2. EVENTO EXTERNO: Recibe respuestas y registros de Telegram
// ─────────────────────────────────────────────────────────
export async function runWebtrigger(request) {
  const body = JSON.parse(request.body);
  const token = process.env.TELEGRAM_TOKEN;

  // ── INTERCEPTAR MENSAJES DE TEXTO PARA REGISTRO ──
  if (body.message && body.message.text) {
    const chatId = body.message.chat.id;
    const text = body.message.text.trim();

    if (text.startsWith('/start')) {
      const parts = text.split(' ');

      if (parts.length < 2) {
        await api.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `👋 ¡Hola! Soy tu bot de Jira.\n\nPara vincular tu cuenta, por favor envíame este comando seguido de tu correo de trabajo.\n\nEjemplo:\n/start juan.perez@empresa.com`
          })
        });
        return { body: "OK", statusCode: 200 };
      }

      const email = parts[1].toLowerCase(); 

      // ── NUEVO: Buscamos al usuario en Jira por su correo ──
      const searchRes = await api.asApp().requestJira(route`/rest/api/3/user/search?query=${email}`);
      const users = await searchRes.json();

      // 🔍 IMPRIMIMOS LA RESPUESTA SECRETA DE JIRA
      console.log(`Respuesta de Jira al buscar ${email}:`, JSON.stringify(users));

      // Blindaje: Verificamos si Jira nos devolvió un error (no es un Array) o una lista vacía
      if (!Array.isArray(users) || users.length === 0) {
        const motivo = !Array.isArray(users) ? "Jira bloqueó la búsqueda (posible restricción de privacidad)." : "No se encontró el correo.";
        
        await api.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `❌ *Error:* ${motivo} Revisa si está bien escrito o si tu correo es visible en tu perfil de Jira.`,
            parse_mode: "Markdown"
          })
        });
        return { body: "OK", statusCode: 200 };
      }

      // Si lo encuentra, extraemos su Account ID y su Nombre Real
      const accountId = users[0].accountId;
      const displayName = users[0].displayName;

      // Guardamos en la base de datos usando el Account ID
      await kvs.set(`tg_chat_${accountId}`, chatId);
      console.log(`✅ Registro exitoso: ${displayName} vinculado a Chat ID: ${chatId}`);

      await api.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `✅ ¡Registro exitoso, *${displayName}*!\n\nHe vinculado tu cuenta de Jira con Telegram. Las tareas que te asignen llegarán aquí.`,
          parse_mode: "Markdown"
        })
      });
    }
    return { body: "OK", statusCode: 200 };
  }

  // ── MANEJO DE BOTONES ──
  if (body.callback_query) {
    const callbackData = body.callback_query.data;
    const chatId = body.callback_query.message.chat.id;

    const [source, action, ...issueKeyParts] = callbackData.split('_');
    const issueKey = issueKeyParts.join('_');
    
    let comentario = "";
    let statusMessageToTelegram = `¡Entendido! Actualicé el estado de ${issueKey} en Jira.`;

    if (source === 'TG') {
      if (action === 'DONE') {
        comentario = `✅ Tarea marcada como Terminada vía Telegram.`;
        const targetStatus = "LISTO"; 
        const transitionSuccess = await transitionIssue(issueKey, targetStatus);
        
        if (!transitionSuccess) {
           comentario += `\n⚠️ Nota: Hubo un error al mover la tarjeta a "${targetStatus}".`;
           statusMessageToTelegram = `Hubo un problema al mover la tarjeta en Jira.`;
        }
      } 
      else if (action === 'AVANCE') { comentario = `🚀 Tarea reportada con avances vía Telegram.`; } 
      else if (action === 'SINAVANCE') { comentario = `🛑 Tarea reportada sin avances vía Telegram.`; }

      if (comentario !== "") {
        await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: comentario }] }] }
          })
        });

        await api.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: statusMessageToTelegram })
        });
      }
    } 
  }

  return { body: "OK", headers: { "Content-Type": ["application/json"] }, statusCode: 200 };
}
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

// ¡Solo debe estar una vez!
export const pageResolver = resolver.getDefinitions();

// ─────────────────────────────────────────────────────────
// [API TELEGRAM] HELPER: ENVÍO DE MENSAJES
// ─────────────────────────────────────────────────────────
async function sendTelegramMessage(chatId, text, issueKey = null) {
  const token = process.env.TELEGRAM_TOKEN;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  let payload = { chat_id: chatId, text: text, parse_mode: "Markdown" };

  if (issueKey) {
    payload.reply_markup = {
      inline_keyboard: [
        [
          { text: "🚀 Con avances", callback_data: `TG_AVANCE_${issueKey}` },
          { text: "🛑 Sin avances", callback_data: `TG_SINAVANCE_${issueKey}` }
        ],
        [
          { text: "✅ Terminada", callback_data: `TG_DONE_${issueKey}` }
        ]
      ]
    };
  }

  await api.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// ─────────────────────────────────────────────────────────
// [API JIRA] HELPER: TRANSICIÓN DE ESTADO
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
// [WEBHOOKS] 1. EVENTO JIRA: ASIGNACIÓN DE TICKET
// ─────────────────────────────────────────────────────────
export async function runTrigger(event, context) {
  const issueKey = event.issue.key;
  
  const issueRes = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`);
  const issueData = await issueRes.json();
  const assignee = issueData.fields?.assignee;

  if (!assignee) return;

  const accountId = assignee.accountId;
  const asignadoA = assignee.displayName || "Equipo"; 

  const chatId = await kvs.get(`tg_chat_${accountId}`);
  if (!chatId) return; 

  const mensaje = `Hola *${asignadoA}*. Se te ha asignado la tarea *${issueKey}*. ¿Cuál es el estado actual?`;
  await sendTelegramMessage(chatId, mensaje, issueKey);
}

// ─────────────────────────────────────────────────────────
// [WEBHOOKS] 2. EVENTO EXTERNO: RESPUESTAS DE TELEGRAM
// ─────────────────────────────────────────────────────────
export async function runWebtrigger(request) {
  const body = JSON.parse(request.body);

  if (body.message && body.message.text) {
    const chatId = body.message.chat.id;
    const text = body.message.text.trim();

    if (text.startsWith('/start')) {
      const parts = text.split(' ');

      if (parts.length < 2 || parts[1].includes('@')) {
        await sendTelegramMessage(chatId, `⚠️ *Registro denegado.*\n\nPor favor, ve al menú superior de Jira, haz clic en "Aplicaciones" -> "Telegram Sync" y utiliza el enlace seguro provisto allí.`);
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

      await sendTelegramMessage(chatId, `✅ ¡Registro exitoso, *${displayName}*!\n\nTu identidad ha sido verificada de forma segura. Recibirás tus asignaciones en este chat.`);
    }
    return { body: "OK", statusCode: 200 };
  }

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

        await sendTelegramMessage(chatId, statusMessageToTelegram);
      }
    } 
  }

  return { body: "OK", headers: { "Content-Type": ["application/json"] }, statusCode: 200 };
}
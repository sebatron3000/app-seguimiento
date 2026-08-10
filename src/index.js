import api, { route, webTrigger } from "@forge/api";
import { kvs } from "@forge/kvs";
import Resolver from '@forge/resolver';

// ─────────────────────────────────────────────────────────
// [UI] RESOLVER: Puente entre frontend y backend
// ─────────────────────────────────────────────────────────
const resolver = new Resolver();

resolver.define('getGlobalProjects', async (req) => {
  const res = await api.asApp().requestJira(route`/rest/api/3/project`);
  if (res.status !== 200) return [];
  const projects = await res.json();
  return projects.map(p => ({ label: `${p.name} (${p.key})`, value: p.key }));
});

resolver.define('getProjectStatuses', async (req) => {
  const projectKey = req.context.extension.project.key;
  const res = await api.asApp().requestJira(route`/rest/api/3/project/${projectKey}/statuses`);
  if (res.status !== 200) return [];
  const data = await res.json();
  const uniqueStatuses = {};
  data.forEach(issueType => {
    issueType.statuses.forEach(status => {
      uniqueStatuses[status.id] = { id: status.id, name: status.name, category: status.statusCategory?.key };
    });
  });
  return Object.values(uniqueStatuses);
});

resolver.define('getWorkflowSequence', async (req) => {
  const projectKey = req.context.extension.project.key;
  return await kvs.get(`proj_workflow_${projectKey}`) || [];
});

resolver.define('saveWorkflowSequence', async (req) => {
  const projectKey = req.context.extension.project.key;
  const { sequence } = req.payload; 
  await kvs.set(`proj_workflow_${projectKey}`, sequence);
  return { success: true };
});

resolver.define('getKPIData', async (req) => {
  const { projects, timeGrouping, cohort } = req.payload;
  let jql = `updated >= -90d`;
  
  if (projects && projects.length > 0 && !projects.includes('all')) {
    jql += ` AND project IN (${projects.map(p => `"${p}"`).join(',')})`;
  }

  const searchRes = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql, fields: ["updated", "created", "resolutiondate", "customfield_10016", "comment", "assignee"], maxResults: 100 })
  });

  const data = await searchRes.json();
  let issues = data.issues || [];

  if (cohort !== 'all') {
    const validIssues = [];
    for (const issue of issues) {
      const accountId = issue.fields.assignee?.accountId;
      if (!accountId) {
        if (cohort === 'no-telegram') validIssues.push(issue);
        continue;
      }
      const chatId = await kvs.get(`tg_chat_${accountId}`);
      const hasTelegram = !!chatId;

      if (cohort === 'telegram' && hasTelegram) validIssues.push(issue);
      else if (cohort === 'no-telegram' && !hasTelegram) validIssues.push(issue);
    }
    issues = validIssues;
  }

  const getWeekNumber = (d) => {
    const date = new Date(d.getTime());
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  };

  let totalInteracciones = 0; let totalEstancadas = 0; let totalEficiencia = 0; let issuesConSP = 0;
  const grouped = {};
  const now = new Date();

  issues.forEach(issue => {
    const updatedDate = new Date(issue.fields.updated);
    const periodKey = timeGrouping === 'meses'
      ? updatedDate.toLocaleString('es-CL', { month: 'long', year: 'numeric' }).toUpperCase()
      : `Semana ${getWeekNumber(updatedDate)}`;
    
    const sortKey = timeGrouping === 'meses' ? updatedDate.getTime() : getWeekNumber(updatedDate);

    if (!grouped[periodKey]) grouped[periodKey] = { interacciones: 0, estancadas: 0, eficiencia: 0, spCount: 0, sortKey };

    const commentsCount = issue.fields.comment?.total || 1;
    grouped[periodKey].interacciones += commentsCount;
    totalInteracciones += commentsCount;

    const diffDays = (now - updatedDate) / (1000 * 60 * 60 * 24);
    if (diffDays > 2 && !issue.fields.resolutiondate) {
      grouped[periodKey].estancadas += 1;
      totalEstancadas += 1;
    }

    const sp = issue.fields.customfield_10016 || 0;
    if (issue.fields.resolutiondate && sp > 0) {
      const resDate = new Date(issue.fields.resolutiondate);
      const createdDate = new Date(issue.fields.created);
      const leadTimeDays = (resDate - createdDate) / (1000 * 60 * 60 * 24);
      const eff = leadTimeDays / sp;

      grouped[periodKey].eficiencia += eff;
      grouped[periodKey].spCount += 1;
      totalEficiencia += eff;
      issuesConSP += 1;
    }
  });

  let tableData = Object.keys(grouped).map(key => {
    const g = grouped[key];
    const effPromedio = g.spCount > 0 ? (g.eficiencia / g.spCount).toFixed(1) : "N/A";
    return { period: key, interacciones: g.interacciones, estancadas: g.estancadas, eficiencia: effPromedio, sortKey: g.sortKey };
  });

  tableData.sort((a, b) => b.sortKey - a.sortKey);
  const avgEficiencia = issuesConSP > 0 ? (totalEficiencia / issuesConSP).toFixed(1) : "N/A";

  return { summary: { interacciones: totalInteracciones, estancadas: totalEstancadas, eficiencia: avgEficiencia }, tableData };
});

resolver.define('getProjectUsers', async (req) => {
  const projectKey = req.context.extension.project.key;
  const res = await api.asApp().requestJira(route`/rest/api/3/user/assignable/search?project=${projectKey}`);
  const users = await res.json();

  const enrichedUsers = await Promise.all(users.map(async (user) => {
    const chatId = await kvs.get(`tg_chat_${user.accountId}`);
    const reportTime = await kvs.get(`tg_time_${user.accountId}`) || "17:00";
    const reportDays = await kvs.get(`tg_days_${user.accountId}`) || [1, 2, 3, 4, 5]; 
    const isLeader = await kvs.get(`tg_leader_${projectKey}_${user.accountId}`) || false;
    const isActiveVal = await kvs.get(`tg_active_${user.accountId}`);
    const isActive = isActiveVal === null ? true : isActiveVal;

    return { accountId: user.accountId, displayName: user.displayName, isSynced: !!chatId, reportTime, reportDays, isLeader, isActive };
  }));
  return enrichedUsers;
});

resolver.define('toggleUserActiveStatus', async (req) => {
  const { accountId, isActive } = req.payload;
  await kvs.set(`tg_active_${accountId}`, isActive);
  return { success: true };
});

resolver.define('checkAdminAccess', async (req) => {
  const accountId = req.context.accountId;
  const projectKey = req.context.extension.project.key;
  const isLeader = await kvs.get(`tg_leader_${projectKey}_${accountId}`) || false;
  let isProjectAdmin = false;
  try {
    const res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=ADMINISTER_PROJECTS`);
    if (res.status === 200) {
      const data = await res.json();
      isProjectAdmin = data.permissions?.ADMINISTER_PROJECTS?.havePermission || false;
    }
  } catch (e) {
    console.error("Error verificando permisos", e);
  }
  return { hasAccess: isLeader || isProjectAdmin };
});

resolver.define('getProjectConfig', async (req) => {
  const projectKey = req.context.extension.project.key;
  const mode = await kvs.get(`proj_mode_${projectKey}`) || 'SCRUM';
  const leaderTime = await kvs.get(`proj_time_${projectKey}`) || '17:00';
  return { mode, leaderTime };
});

resolver.define('saveProjectConfig', async (req) => {
  const { projectKey, mode, leaderTime } = req.payload;
  await kvs.set(`proj_mode_${projectKey}`, mode);
  await kvs.set(`proj_time_${projectKey}`, leaderTime);
  return { success: true };
});

resolver.define('toggleLeaderRole', async (req) => {
  const { projectKey, accountId, isLeader } = req.payload;
  await kvs.set(`tg_leader_${projectKey}_${accountId}`, isLeader);
  return { success: true };
});

resolver.define('triggerManualPings', async (req) => {
  const { accountId, projectKey, type } = req.payload || {}; 
  await runScheduledPings(null, null, true, accountId, projectKey, type); 
  return { success: true };
});

resolver.define('updateReportTime', async (req) => {
  const { accountId, newTime, newDays, isGlobal, projectKey } = req.payload;
  if (isGlobal) {
    const res = await api.asApp().requestJira(route`/rest/api/3/user/assignable/search?project=${projectKey}`);
    const users = await res.json();
    for (const user of users) {
      await kvs.set(`tg_time_${user.accountId}`, newTime);
      await kvs.set(`tg_days_${user.accountId}`, newDays); 
    }
  } else {
    await kvs.set(`tg_time_${accountId}`, newTime);
    await kvs.set(`tg_days_${accountId}`, newDays);
  }
  return { success: true };
});

resolver.define('createInviteTask', async (req) => {
  const { accountId, projectKey } = req.payload;
  const token = Math.random().toString(36).substring(2, 8).toUpperCase();
  const expiresAt = Date.now() + (24 * 60 * 60 * 1000); 
  
  const webhookUrl = await webTrigger.getUrl('telegram-webhook');

  // Enviar el token al GCP
  await api.fetch('https://pmbot-proxy-tgtrm3z5ca-uc.a.run.app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { text: `/start ${token}`, chat: { id: "SYSTEM_REGISTER" } },
      system_registration: { token, accountId, forgeWebhookUrl: webhookUrl, expiresAt }
    })
  });

  // Usamos variable de entorno para el nombre del bot central (ver instrucciones abajo)
  const botUsername = process.env.BOT_USERNAME || "TuBotCentral"; 
  const botUrl = `https://t.me/${botUsername}?start=${token}`;

  const projRes = await api.asApp().requestJira(route`/rest/api/3/project/${projectKey}`);
  const projData = await projRes.json();
  let issueTypeId = projData.issueTypes?.find(it => !it.subtask)?.id;
  const preferred = projData.issueTypes?.find(it => !it.subtask && (it.name.toLowerCase() === 'task' || it.name.toLowerCase() === 'tarea'));
  if (preferred) issueTypeId = preferred.id;

  let activeSprintId = null;
  try {
    const boardsRes = await api.asApp().requestJira(route`/rest/agile/1.0/board?projectKeyOrId=${projectKey}`);
    if (boardsRes.status === 200) {
      const boardsData = await boardsRes.json();
      for (const board of (boardsData.values || [])) {
        if (board.type === 'scrum') {
          const sprintRes = await api.asApp().requestJira(route`/rest/agile/1.0/board/${board.id}/sprint?state=active`);
          if (sprintRes.status === 200) {
            const sprintData = await sprintRes.json();
            if (sprintData.values && sprintData.values.length > 0) {
              activeSprintId = sprintData.values[0].id;
              break; 
            }
          }
        }
      }
    }
  } catch (error) {
    console.error("Error buscando sprint activo:", error);
  }

  const payload = {
    fields: {
      project: { key: projectKey },
      summary: "Vincular con Telegram",
      issuetype: { id: issueTypeId },
      assignee: { id: accountId },
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: botUrl, marks: [{ type: "link", attrs: { href: botUrl } }] }] }]
      }
    }
  };

  const createRes = await api.asApp().requestJira(route`/rest/api/3/issue`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (createRes.status !== 201) throw new Error("No se pudo crear la tarea de invitación.");
  const newIssue = await createRes.json();

  if (activeSprintId) {
    try {
      await new Promise(resolve => setTimeout(resolve, 1500));
      await api.asApp().requestJira(route`/rest/agile/1.0/sprint/${activeSprintId}/issue`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ issues: [newIssue.key] })
      });
    } catch (error) {}
  }
  return { success: true };
});

resolver.define('generateInviteLink', async (req) => {
  const { accountId } = req.payload;
  const token = Math.random().toString(36).substring(2, 8).toUpperCase();
  const webhookUrl = await webTrigger.getUrl('telegram-webhook');

  await api.fetch('https://pmbot-proxy-tgtrm3z5ca-uc.a.run.app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { text: `/start ${token}`, chat: { id: "SYSTEM_REGISTER" } },
      system_registration: { token, accountId, forgeWebhookUrl: webhookUrl, expiresAt: Date.now() + (24 * 60 * 60 * 1000) }
    })
  });
  return token;
});

export const pageResolver = resolver.getDefinitions();

// ─────────────────────────────────────────────────────────
// [API TELEGRAM] HELPER: ENVÍO DE MENSAJES DINÁMICOS
// ─────────────────────────────────────────────────────────
async function sendTelegramMessage(chatId, text, inlineKeyboard = null) {
  // LECTURA DE VARIABLE DE ENTORNO GLOBAL EN FORGE (Ver instrucciones abajo)
  const token = process.env.SECRET_TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("Falta la variable SECRET_TELEGRAM_BOT_TOKEN en el entorno Forge.");
    return;
  }
  
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  let payload = { chat_id: chatId, text: text, parse_mode: "Markdown" };
  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };

  await api.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// ─────────────────────────────────────────────────────────
// [API JIRA] HELPERS
// ─────────────────────────────────────────────────────────
async function getIssueData(issueKey) {
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,status,project`);
    if (res.status === 200) {
      const data = await res.json();
      return {
        summary: data.fields?.summary || "Sin título",
        status: data.fields?.status?.name || "Desconocido",
        statusId: data.fields?.status?.id || null, 
        category: data.fields?.status?.statusCategory?.key || "new",
        projectKey: data.fields?.project?.key 
      };
    }
    return { summary: "Sin título", status: "Desconocido", statusId: null, category: "new", projectKey: null };
  } catch (error) {
    return { summary: "Sin título", status: "Desconocido", statusId: null, category: "new", projectKey: null };
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

async function getNextForwardTransition(issueKey, projectKey, currentStatusId) {
  try {
    const workflowSequence = await kvs.get(`proj_workflow_${projectKey}`);
    if (!workflowSequence || workflowSequence.length === 0) return null;

    const currentIndex = workflowSequence.indexOf(currentStatusId);
    if (currentIndex === -1 || currentIndex >= workflowSequence.length - 1) return null;

    const nextStatusId = workflowSequence[currentIndex + 1];
    const transitions = await getAvailableTransitions(issueKey);
    return transitions.find(t => t.to?.id === nextStatusId) || null;
  } catch (error) {
    return null;
  }
}

async function getOpenSubtasksCount(issueKey) {
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=subtasks`);
    if (res.status !== 200) return 0;
    const data = await res.json();
    const openSubtasks = (data.fields?.subtasks || []).filter(sub => {
      const statusName = sub.fields?.status?.name?.toUpperCase() || "";
      return statusName !== "LISTO" && statusName !== "DONE";
    });
    return openSubtasks.length;
  } catch (error) {
    return 0;
  }
}

async function transitionIssue(issueKey, targetIdentifier) {
  if (!targetIdentifier) return false;
  const transitions = await getAvailableTransitions(issueKey);
  const targetStr = targetIdentifier.toString();
  
  let transition = transitions.find(t => t.id === targetStr);
  if (!transition) transition = transitions.find(t => t.to && t.to.id === targetStr);
  if (!transition) {
    const targetLower = targetStr.trim().toLowerCase();
    transition = transitions.find(
      t => (t.name && t.name.trim().toLowerCase() === targetLower) || 
           (t.to && t.to.name && t.to.name.trim().toLowerCase() === targetLower)
    );
  }

  if (!transition) return false;

  const postResponse = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/transitions`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ transition: { id: transition.id } })
  });

  return postResponse.status === 204;
}

async function sweepSubtasks(parentIssueKey) {
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${parentIssueKey}?fields=subtasks`);
    if (res.status !== 200) return 0;
    const subtasks = (await res.json()).fields?.subtasks || [];
    let closedCount = 0;

    for (const sub of subtasks) {
      const success = await transitionIssue(sub.key, "LISTO");
      if (success) {
        await agregarComentarioFijo(sub.key, "Subtarea cerrada automáticamente por barrido (vía Telegram).");
        closedCount++;
      }
    }
    return closedCount;
  } catch (error) {
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
  const chatId = await kvs.get(`tg_chat_${accountId}`);
  if (!chatId) return; 

  const isActive = await kvs.get(`tg_active_${accountId}`);
  if (isActive === false) return;

  await sendTelegramMessage(chatId, `*Nueva Asignación*\nHola *${assignee.displayName || "Equipo"}*, se te ha asignado la tarea:\n\n📌 *${issueKey} - ${summary}*`);
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
        await sendTelegramMessage(chatId, `Registro denegado.\nPídele a tu líder un link de invitación.`);
        return { body: "OK", statusCode: 200 };
      }
      
      // En la nueva arquitectura, el proxy de GCP se encarga del emparejamiento usando /start.
      // Esta lógica en Jira es un respaldo en caso de latencias de enrolamiento.
      const userRes = await api.asApp().requestJira(route`/rest/api/3/user?accountId=${parts[1]}`); // Backup id if passed
      return { body: "OK", statusCode: 200 };
    }

    if (text.toLowerCase() === 'cancelar') {
      await kvs.delete(`chat_state_${chatId}`);
      await sendTelegramMessage(chatId, `Acción cancelada. El bot está listo para nuevas instrucciones.`);
      return { body: "OK", statusCode: 200 };
    }

    const chatState = await kvs.get(`chat_state_${chatId}`);
    if (chatState) {
      const { issueKey, action } = chatState;
      const issueDataAPI = await getIssueData(issueKey);
      const comentarioFinal = `${action === 'AVANCE' ? "Avance reportado:\n" : "Motivo de retraso:\n"}${text}`;

      await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: comentarioFinal }] }] } })
      });

      await kvs.delete(`chat_state_${chatId}`);
      await sendTelegramMessage(chatId, `Tu comentario ha sido publicado en:\n*${issueKey} - ${issueDataAPI.summary}*`);
      return { body: "OK", statusCode: 200 };
    }
    return { body: "OK", statusCode: 200 };
  }

  if (body.callback_query) {
    const callbackData = body.callback_query.data;
    const chatId = body.callback_query.message.chat.id;
    const [source, action, ...issueKeyParts] = callbackData.split('_');
    const issueKey = issueKeyParts.join('_');
    const issueDataAPI = await getIssueData(issueKey); 
    const tituloCompleto = `*${issueKey} - ${issueDataAPI.summary}*`;

    if (source === 'TG') {
      try {
        if (action === 'FORWARD') {
          const nextTransition = await getNextForwardTransition(issueKey, issueDataAPI.projectKey, issueDataAPI.statusId);
          if (nextTransition) {
            const isMovingToDone = nextTransition.to?.statusCategory?.key === 'done';
            if (isMovingToDone) {
              const openSubtasksCount = await getOpenSubtasksCount(issueKey);
              if (openSubtasksCount > 0) {
                 await sendTelegramMessage(chatId, `Atención: La tarea ${tituloCompleto} tiene ${openSubtasksCount} subtarea(s) en curso.\n\n¿Deseas moverla a "${nextTransition.to?.name}" y finalizar dependencias?`, [
                   [ { text: "Sí, avanzar y barrer subtareas", callback_data: `TG_SWEEPFORWARD_${issueKey}` } ],
                   [ { text: "Cancelar", callback_data: `TG_CANCEL_${issueKey}` } ]
                 ]);
                 return { body: "OK", statusCode: 200 };
              }
            }
            if (await transitionIssue(issueKey, nextTransition.id)) {
              await agregarComentarioFijo(issueKey, `Tarea movida a ${nextTransition.to?.name} vía Telegram.`);
              await sendTelegramMessage(chatId, `Excelente. Moví el ticket a "${nextTransition.to?.name}".`);
            } else {
              await sendTelegramMessage(chatId, `Problema al intentar mover el ticket. Verifica permisos en Jira.`);
            }
          } else {
             await sendTelegramMessage(chatId, `No hay transiciones lógicas disponibles en el tablero.`);
          }
        }
        else if (action === 'SWEEPFORWARD') {
           const nextTransition = await getNextForwardTransition(issueKey, issueDataAPI.projectKey, issueDataAPI.statusId);
           if (nextTransition && await transitionIssue(issueKey, nextTransition.id)) {
             const subtasksClosed = await sweepSubtasks(issueKey);
             const sweepMsg = subtasksClosed > 0 ? `\nSe cerraron ${subtasksClosed} subtareas asociadas.` : "";
             await agregarComentarioFijo(issueKey, `Tarea y subtareas movidas en bloque vía Telegram.${sweepMsg}`);
             await sendTelegramMessage(chatId, `Excelente. Moví el ticket y sus dependencias a "${nextTransition.to?.name}".${sweepMsg}`);
           }
        }
        else if (action === 'DOUBLEJUMP') {
           if (issueDataAPI.category !== 'new') return { body: "OK", statusCode: 200 };
           const firstTransition = await getNextForwardTransition(issueKey, issueDataAPI.projectKey, issueDataAPI.statusId);
           if (!firstTransition || !(await transitionIssue(issueKey, firstTransition.id))) return { body: "OK", statusCode: 200 };
           
           await new Promise(resolve => setTimeout(resolve, 2000));
           const secondTransition = await getNextForwardTransition(issueKey, issueDataAPI.projectKey, firstTransition.to.id);
           
           if (secondTransition && await transitionIssue(issueKey, secondTransition.id)) {
               await agregarComentarioFijo(issueKey, `Tarea avanzada directamente a "${secondTransition.to?.name}" (Doble salto).`);
               await sendTelegramMessage(chatId, `El ticket avanzó directo a "${secondTransition.to?.name}".`);
           }
        }
        else if (action === 'AVANCE') {
          if (issueDataAPI.category === 'new') {
            const nextTransition = await getNextForwardTransition(issueKey, issueDataAPI.projectKey, issueDataAPI.statusId);
            if (nextTransition) await transitionIssue(issueKey, nextTransition.id);
          }
          await kvs.set(`chat_state_${chatId}`, { issueKey, action: 'AVANCE' });
          await sendTelegramMessage(chatId, `¿Qué avances lograste en:\n${tituloCompleto}?\n\nEscríbelo en un mensaje y lo registraré.\n_(Escribe "cancelar" para abortar)_`);
        } 
        else if (action === 'SINAVANCE') {
          await sendTelegramMessage(chatId, `¿Hay algún problema o bloqueo con:\n${tituloCompleto}?\n\nSelecciona una opción:`, [
            [ { text: "Reportar problema", callback_data: `TG_PROBLEMA_${issueKey}` } ],
            [ { text: "Sin problemas", callback_data: `TG_SINPROBLEMA_${issueKey}` } ]
          ]);
        }
        else if (action === 'PROBLEMA') {
          await kvs.set(`chat_state_${chatId}`, { issueKey, action: 'PROBLEMA' });
          await sendTelegramMessage(chatId, `Entendido. ¿Cuál es el problema con:\n${tituloCompleto}?\n\nEscríbelo abajo para registrarlo.\n_(Escribe "cancelar" para abortar)_`);
        }
        else if (action === 'SINPROBLEMA') {
          await sendTelegramMessage(chatId, `Entendido. Tarea ${issueKey} sin novedades por hoy.`);
        }
        else if (action === 'CANCEL') {
          await kvs.delete(`chat_state_${chatId}`);
          await sendTelegramMessage(chatId, `Acción cancelada.`);
        }
      } catch (error) {
        await sendTelegramMessage(chatId, `⚠️ Ocurrió un error interno al procesar tu solicitud.`);
      }
    } 
  }
  return { body: "OK", headers: { "Content-Type": ["application/json"] }, statusCode: 200 };
}

async function agregarComentarioFijo(issueKey, texto) {
  await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: texto }] }] } })
  });
}

// ─────────────────────────────────────────────────────────
// [WEBHOOKS] 3. EVENTO PROGRAMADO (CRON): REPORTES Y DIGESTS
// ─────────────────────────────────────────────────────────
export async function runScheduledPings(event, context, isForced = false, targetAccountId = null, targetProjectKey = null, runType = 'ALL') {
  const chileTime = new Date().toLocaleString("en-US", { timeZone: "America/Santiago", hour12: false });
  const currentHour = new Date(chileTime).getHours();
  const currentDay = new Date(chileTime).getDay(); 

  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' });
  const todayStr = formatter.format(new Date());

  const projRes = await api.asApp().requestJira(route`/rest/api/3/project`);
  if (projRes.status !== 200) return;
  const projects = await projRes.json();

  const serverInfoRes = await api.asApp().requestJira(route`/rest/api/3/serverInfo`);
  let baseUrl = serverInfoRes.status === 200 ? (await serverInfoRes.json()).baseUrl : "";

  for (const proj of projects) {
    if (targetProjectKey && proj.key !== targetProjectKey) continue;

    const mode = await kvs.get(`proj_mode_${proj.key}`) || 'SCRUM';
    const leaderTimeStr = await kvs.get(`proj_time_${proj.key}`) || '17:00';
    const leaderHour = parseInt(leaderTimeStr.split(':')[0], 10);

    let jqlQuery = `project = "${proj.key}" AND (resolution = Unresolved OR resolved >= -1d) AND assignee IS NOT EMPTY`;
    if (mode === 'SCRUM') jqlQuery += ` AND sprint IN openSprints()`;
    if (targetAccountId && runType === 'EXECUTOR') jqlQuery += ` AND assignee = "${targetAccountId}"`;

    const searchRes = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql: jqlQuery, fields: ["summary", "status", "assignee", "issuelinks", "startdate", "customfield_10015", "duedate", "updated"], maxResults: 100 })
    });
    
    const data = await searchRes.json();
    const validTasks = [];
    const userTasks = {};

    if (data.issues && data.issues.length > 0) {
      for (const issue of data.issues) {
        const assignee = issue.fields.assignee;
        const startDateStr = issue.fields.startdate || issue.fields.customfield_10015;
        if (startDateStr && startDateStr.substring(0, 10) > todayStr) continue; 

        let isBlocked = false;
        if (issue.fields.issuelinks) {
          for (const link of issue.fields.issuelinks) {
            if (link.type.name === "Blocks" && link.inwardIssue && link.inwardIssue.fields?.status?.statusCategory?.key !== 'done') {
              isBlocked = true; break; 
            }
          }
        }
        if (isBlocked) continue; 

        validTasks.push(issue);
        if (!(issue.fields.resolution || issue.fields.status?.statusCategory?.key === 'done')) {
          if (!userTasks[assignee.accountId]) userTasks[assignee.accountId] = { displayName: assignee.displayName, issues: [] };
          userTasks[assignee.accountId].issues.push(issue);
        }
      }
    }

    if (runType === 'ALL' || runType === 'EXECUTOR') {
      for (const [accountId, userData] of Object.entries(userTasks)) {
        const chatId = await kvs.get(`tg_chat_${accountId}`);
        if (!chatId || await kvs.get(`tg_active_${accountId}`) === false) continue; 
        
        const reportTime = await kvs.get(`tg_time_${accountId}`) || "17:00";
        const reportDays = await kvs.get(`tg_days_${accountId}`) || [1, 2, 3, 4, 5];
        if (!isForced && (!reportDays.includes(currentDay) || parseInt(reportTime.split(':')[0], 10) !== currentHour)) continue;

        await sendTelegramMessage(chatId, `Hola ${userData.displayName}, revisemos tus asignaciones:`);
        for (const issue of userData.issues) {
          let timeStatus = "";
          if (issue.fields.duedate) timeStatus = ` | Vence: ${issue.fields.duedate}${issue.fields.duedate < todayStr ? " (Atrasada)" : issue.fields.duedate === todayStr ? " (Hoy)" : ""}`;

          const statusCategory = issue.fields.status?.statusCategory?.key || 'new';
          const nextTransition = await getNextForwardTransition(issue.key, proj.key, issue.fields.status?.id);
          const taskKeyboard = [[{ text: "Con avances", callback_data: `TG_AVANCE_${issue.key}` }], [{ text: "Sin avances", callback_data: `TG_SINAVANCE_${issue.key}` }]];

          if (statusCategory === 'new') taskKeyboard.push([{ text: "Avanzar a siguiente etapa", callback_data: `TG_DOUBLEJUMP_${issue.key}` }]);
          else if (nextTransition) taskKeyboard.push([{ text: `Mover a ${nextTransition.to.name.substring(0, 15)}`, callback_data: `TG_FORWARD_${issue.key}` }]);
          else if (statusCategory === 'indeterminate') taskKeyboard.push([{ text: "Marcar como Terminada", callback_data: `TG_FORWARD_${issue.key}` }]);

          await sendTelegramMessage(chatId, `↳ *${issue.key}* - [${issue.fields.summary}](${baseUrl}/browse/${issue.key})\n_Estado: ${issue.fields.status?.name || 'Desconocido'}${timeStatus}_`, taskKeyboard);
        }
      }
    }

    if (runType === 'ALL' || runType === 'LEADER') {
      if (leaderHour === currentHour || isForced) {
        const resUsers = await api.asApp().requestJira(route`/rest/api/3/user/assignable/search?project=${proj.key}`);
        const allAssignables = await resUsers.json();
        const leaderChatIds = [];
        
        for (const u of allAssignables) {
          if (await kvs.get(`tg_leader_${proj.key}_${u.accountId}`)) {
            const chat = await kvs.get(`tg_chat_${u.accountId}`);
            if (chat) leaderChatIds.push(chat);
          }
        }

        if (leaderChatIds.length > 0) {
          if (validTasks.length === 0) {
            const emptyMsg = `⭘ *Sin Novedades en ${proj.name}*\nEl tablero está vacío o no hay tareas activas.`;
            for (const chat of leaderChatIds) await sendTelegramMessage(chat, emptyMsg);
            continue;
          }

          const terminadas = []; const atrasadas = []; const problemas = []; const avances = []; const sinNovedades = [];
          const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

          for (const issue of validTasks) {
            const name = issue.fields.assignee?.displayName.split(' ')[0] || "Alguien";
            const dueText = issue.fields.duedate ? ` (V: ${issue.fields.duedate.split('-').reverse().join('-')})` : "";
            
            if (issue.fields.resolution || issue.fields.status?.statusCategory?.key === 'done') { terminadas.push(`↳ *${issue.key}* - _${name}_${dueText}`); continue; }
            if (issue.fields.duedate && issue.fields.duedate < todayStr) atrasadas.push(`↳ *${issue.key}* - _${name}_${dueText}`);

            if (new Date(issue.fields.updated) > yesterday) {
              const comRes = await api.asApp().requestJira(route`/rest/api/3/issue/${issue.key}/comment?orderBy=-created&maxResults=5`);
              let categorized = false;
              for (const c of (await comRes.json()).comments || []) {
                if (new Date(c.created) > yesterday) {
                  const text = c.body?.content?.[0]?.content?.[0]?.text || "";
                  if (text.includes("Motivo de retraso:") || text.includes("Problema reportado:")) { problemas.push(`↳ *${issue.key}* - _${name}_${dueText}\n    💬 _"${text.split('\n').pop()}"_`); categorized = true; break; }
                  if (text.includes("Avance reportado:")) { avances.push(`↳ *${issue.key}* - _${name}_${dueText}\n    💬 _"${text.split('\n').pop()}"_`); categorized = true; break; }
                }
              }
              if (!categorized) sinNovedades.push(`↳ *${issue.key}* - _${name}_${dueText}`);
            } else {
              sinNovedades.push(`↳ *${issue.key}* - _${name}_${dueText}`);
            }
          }

          let digestMsg = `📊 *Reporte Diario:* [${proj.name}](${baseUrl}/browse/${proj.key})\n\n✓ Terminadas: ${terminadas.length}\n⬈ Avances: ${avances.length}\n⊘ Problemas: ${problemas.length}\n◬ Atrasadas: ${atrasadas.length}\n⭘ Sin Novedades: ${sinNovedades.length}\n\n`;
          if (terminadas.length > 0) digestMsg += `*✓ TERMINADAS*\n${terminadas.join('\n')}\n\n`;
          if (avances.length > 0) digestMsg += `*⬈ AVANCES*\n${avances.join('\n')}\n\n`;
          if (problemas.length > 0) digestMsg += `*⊘ PROBLEMAS*\n${problemas.join('\n')}\n\n`;
          if (atrasadas.length > 0) digestMsg += `*◬ ATRASADAS*\n${atrasadas.join('\n')}\n\n`;
          
          for (const chat of leaderChatIds) await sendTelegramMessage(chat, digestMsg);
        }
      }
    }
  }
}
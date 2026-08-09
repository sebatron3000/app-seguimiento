import api, { route, webTrigger } from "@forge/api";
import { kvs } from "@forge/kvs";
import Resolver from '@forge/resolver';

// ─────────────────────────────────────────────────────────
// [UI] RESOLVER: Puente entre frontend y backend
// ─────────────────────────────────────────────────────────
const resolver = new Resolver();

// NUEVO: Obtener todos los proyectos reales de Jira para el panel global
resolver.define('getGlobalProjects', async (req) => {
  const res = await api.asApp().requestJira(route`/rest/api/3/project`);
  if (res.status !== 200) return [];
  
  const projects = await res.json();
  // Transformamos los datos al formato { label, value } que necesita el Select del frontend
  return projects.map(p => ({
    label: `${p.name} (${p.key})`,
    value: p.key
  }));
});

// NUEVO: Obtener estados únicos del proyecto para armar la secuencia
resolver.define('getProjectStatuses', async (req) => {
  const projectKey = req.context.extension.project.key;
  const res = await api.asApp().requestJira(route`/rest/api/3/project/${projectKey}/statuses`);
  if (res.status !== 200) return [];
  
  const data = await res.json();
  const uniqueStatuses = {};
  
  // Jira agrupa los estados por tipo de tarea, los aplanamos para mostrar uno de cada uno
  data.forEach(issueType => {
    issueType.statuses.forEach(status => {
      uniqueStatuses[status.id] = {
        id: status.id,
        name: status.name,
        category: status.statusCategory?.key
      };
    });
  });
  
  return Object.values(uniqueStatuses);
});

// NUEVO: Obtener la secuencia configurada
resolver.define('getWorkflowSequence', async (req) => {
  const projectKey = req.context.extension.project.key;
  return await kvs.get(`proj_workflow_${projectKey}`) || [];
});

// NUEVO: Guardar la secuencia configurada
resolver.define('saveWorkflowSequence', async (req) => {
  const projectKey = req.context.extension.project.key;
  const { sequence } = req.payload; // Recibe un arreglo de IDs: ['10000', '3', '10001']
  await kvs.set(`proj_workflow_${projectKey}`, sequence);
  return { success: true };
});

// ─────────────────────────────────────────────────────────
// NUEVO: ONBOARDING WIZARD (Configuración Inicial por Empresa)
// ─────────────────────────────────────────────────────────
resolver.define('getBotSetup', async (req) => {
  const token = await kvs.get('telegram_bot_token');
  return { isSetup: !!token }; // Devuelve true si el token ya está guardado
});

resolver.define('saveBotToken', async (req) => {
  const { token } = req.payload;
  
  try {
    // 1. Validar el token contra Telegram
    const verifyRes = await api.fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (verifyRes.status !== 200) {
      return { success: false, error: "Token inválido. Verifica que copiaste el texto correcto de BotFather." };
    }
    
    const botData = await verifyRes.json();
    const botUsername = botData.result.username; 
    
    // 2. MAGIA: Obtener la URL dinámica del Webhook de esta instalación en Forge
    // 'telegram-webhook' es el nombre exacto que le dimos en tu manifest.yml
    const webhookUrl = await webTrigger.getUrl('telegram-webhook');
    
    // 3. Vincular el Webhook automáticamente en Telegram
    const setWebhookRes = await api.fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    
    if (setWebhookRes.status !== 200) {
       return { success: false, error: "El bot es válido, pero hubo un error al enlazarlo con Jira (Webhook)." };
    }
    
    // 4. Guardar datos en la base de datos local de esta empresa
    await kvs.set('telegram_bot_token', token);
    await kvs.set('telegram_bot_username', botUsername); 
    
    return { success: true };
  } catch (error) {
    console.error("Error en configuración:", error);
    return { success: false, error: "Error interno al intentar configurar el bot." };
  }
});

resolver.define('getKPIData', async (req) => {
  const { projects, timeGrouping, cohort } = req.payload;

  // 1. Ejecutamos el JQL base SIN el filtro de Telegram
  let jql = `updated >= -90d`;
  
  if (projects && projects.length > 0 && !projects.includes('all')) {
    jql += ` AND project IN (${projects.map(p => `"${p}"`).join(',')})`;
  }

  const searchRes = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jql,
      fields: ["updated", "created", "resolutiondate", "customfield_10016", "comment", "assignee"],
      maxResults: 100 
    })
  });

  const data = await searchRes.json();
  let issues = data.issues || [];

  // 2. SOLUCIÓN: Filtramos los tickets en memoria consultando tu base de datos KVS real
  if (cohort !== 'all') {
    const validIssues = [];
    for (const issue of issues) {
      const accountId = issue.fields.assignee?.accountId;
      
      // Si la tarea no tiene asignado, va por defecto a "no-telegram"
      if (!accountId) {
        if (cohort === 'no-telegram') validIssues.push(issue);
        continue;
      }

      // Revisamos si el usuario específico está registrado en Telegram (misma lógica que admin.jsx)
      const chatId = await kvs.get(`tg_chat_${accountId}`);
      const hasTelegram = !!chatId;

      if (cohort === 'telegram' && hasTelegram) {
        validIssues.push(issue);
      } else if (cohort === 'no-telegram' && !hasTelegram) {
        validIssues.push(issue);
      }
    }
    // Reemplazamos la lista de tareas original por la lista filtrada
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

  return { 
    summary: { interacciones: totalInteracciones, estancadas: totalEstancadas, eficiencia: avgEficiencia }, 
    tableData 
  };
});

resolver.define('generateToken', async (req) => {
  const accountId = req.context.accountId;
  const token = Math.random().toString(36).substring(2, 8).toUpperCase();
  await kvs.set(`pending_token_${token}`, accountId);
  return token;
});

// OBTENER USUARIOS Y SUS ROLES EN EL BOT
resolver.define('getProjectUsers', async (req) => {
  const projectKey = req.context.extension.project.key;
  const res = await api.asApp().requestJira(route`/rest/api/3/user/assignable/search?project=${projectKey}`);
  const users = await res.json();

  const enrichedUsers = await Promise.all(users.map(async (user) => {
    const chatId = await kvs.get(`tg_chat_${user.accountId}`);
    const reportTime = await kvs.get(`tg_time_${user.accountId}`) || "17:00";
    const reportDays = await kvs.get(`tg_days_${user.accountId}`) || [1, 2, 3, 4, 5]; 
    const isLeader = await kvs.get(`tg_leader_${projectKey}_${user.accountId}`) || false;
    
    // NUEVO: Rescatar el estado de activación (por defecto es true si no existe)
    const isActiveVal = await kvs.get(`tg_active_${user.accountId}`);
    const isActive = isActiveVal === null ? true : isActiveVal;

    return {
      accountId: user.accountId,
      displayName: user.displayName,
      isSynced: !!chatId,
      reportTime,
      reportDays,
      isLeader,
      isActive // Enviamos esto al frontend
    };
  }));
  return enrichedUsers;
});

// NUEVA FUNCIÓN: Encender o apagar notificaciones
resolver.define('toggleUserActiveStatus', async (req) => {
  const { accountId, isActive } = req.payload;
  await kvs.set(`tg_active_${accountId}`, isActive);
  return { success: true };
});

// NUEVO: Control de Accesos para Telegram Admin
resolver.define('checkAdminAccess', async (req) => {
  const accountId = req.context.accountId;
  const projectKey = req.context.extension.project.key;

  // 1. Revisamos si tiene la medalla de "Líder" en nuestra base de datos
  const isLeader = await kvs.get(`tg_leader_${projectKey}_${accountId}`) || false;

  // 2. Revisamos si es Administrador nativo del proyecto en Jira (Crucial para la configuración inicial)
  let isProjectAdmin = false;
  try {
    // CORRECCIÓN: Agregamos la "S" a ADMINISTER_PROJECTS
    const res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=ADMINISTER_PROJECTS`);
    if (res.status === 200) {
      const data = await res.json();
      isProjectAdmin = data.permissions?.ADMINISTER_PROJECTS?.havePermission || false;
    }
  } catch (e) {
    console.error("Error verificando permisos de administrador", e);
  }

  return { hasAccess: isLeader || isProjectAdmin };
});

// NUEVO: Obtener configuración global del proyecto
resolver.define('getProjectConfig', async (req) => {
  const projectKey = req.context.extension.project.key;
  const mode = await kvs.get(`proj_mode_${projectKey}`) || 'SCRUM';
  const leaderTime = await kvs.get(`proj_time_${projectKey}`) || '17:00';
  return { mode, leaderTime };
});

// NUEVO: Guardar configuración global
resolver.define('saveProjectConfig', async (req) => {
  const { projectKey, mode, leaderTime } = req.payload;
  await kvs.set(`proj_mode_${projectKey}`, mode);
  await kvs.set(`proj_time_${projectKey}`, leaderTime);
  return { success: true };
});

// NUEVO: Otorgar o quitar rol de líder
resolver.define('toggleLeaderRole', async (req) => {
  const { projectKey, accountId, isLeader } = req.payload;
  await kvs.set(`tg_leader_${projectKey}_${accountId}`, isLeader);
  return { success: true };
});


// ACTUALIZACIÓN: Gatillo manual para soportar pruebas del líder
resolver.define('triggerManualPings', async (req) => {
  const { accountId, projectKey, type } = req.payload || {}; 
  console.log(`🔔 Prueba manual. Tipo: ${type}. Objetivo: ${accountId || projectKey || 'TODOS'}`);
  await runScheduledPings(null, null, true, accountId, projectKey, type); 
  return { success: true };
});

// NUEVA FUNCIÓN: Actualizar hora de reporte (Individual o Masiva)
resolver.define('updateReportTime', async (req) => {
  const { accountId, newTime, newDays, isGlobal, projectKey } = req.payload;

  if (isGlobal) {
    const res = await api.asApp().requestJira(route`/rest/api/3/user/assignable/search?project=${projectKey}`);
    const users = await res.json();

    for (const user of users) {
      await kvs.set(`tg_time_${user.accountId}`, newTime);
      await kvs.set(`tg_days_${user.accountId}`, newDays); // NUEVO
    }
    return { success: true };
  } else {
    await kvs.set(`tg_time_${accountId}`, newTime);
    await kvs.set(`tg_days_${accountId}`, newDays); // NUEVO
    return { success: true };
  }
});

// NUEVA FUNCIÓN: Crear ticket de invitación automático
resolver.define('createInviteTask', async (req) => {
  const { accountId, projectKey } = req.payload;
  const token = Math.random().toString(36).substring(2, 8).toUpperCase();
  
  // Expiración en 24 horas
  const expiresAt = Date.now() + (24 * 60 * 60 * 1000); 
  await kvs.set(`pending_token_${token}`, { accountId, expiresAt });
  
  // Obtenemos el alias dinámico
  const botUsername = await kvs.get('telegram_bot_username');
  const botUrl = `https://t.me/${botUsername}?start=${token}`;

  // 1. Buscamos los tipos de tareas válidos en este proyecto
  const projRes = await api.asApp().requestJira(route`/rest/api/3/project/${projectKey}`);
  const projData = await projRes.json();
  
  let issueTypeId = projData.issueTypes?.find(it => !it.subtask)?.id;
  const preferred = projData.issueTypes?.find(it => !it.subtask && (it.name.toLowerCase() === 'task' || it.name.toLowerCase() === 'tarea'));
  if (preferred) issueTypeId = preferred.id;

  // 2. BUSCAMOS EL SPRINT ACTIVO ANTES DE CREAR LA TAREA
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
    console.error("No se pudo obtener el tablero o sprint:", error);
  }

  // 3. Creamos el ticket en Jira
  const payload = {
    fields: {
      project: { key: projectKey },
      summary: "Vincular con Telegram",
      issuetype: { id: issueTypeId },
      assignee: { id: accountId },
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: botUrl, marks: [{ type: "link", attrs: { href: botUrl } }] }
            ]
          }
        ]
      }
    }
  };

  const createRes = await api.asApp().requestJira(route`/rest/api/3/issue`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (createRes.status !== 201) {
    throw new Error("No se pudo crear la tarea de invitación.");
  }

  const newIssue = await createRes.json();

  // 4. MOVEMOS LA TAREA AL SPRINT (Con pausa para evitar la condición de carrera)
  if (activeSprintId) {
    try {
      // Pausa de 1.5 segundos para darle tiempo a Jira de indexar la tarea nueva
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const moveRes = await api.asApp().requestJira(route`/rest/agile/1.0/sprint/${activeSprintId}/issue`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ issues: [newIssue.key] })
      });

      if (!moveRes.ok) {
        console.error("Fallo al mover al sprint. Detalles:", await moveRes.text());
      }
    } catch (error) {
      console.error("Error en la ejecución de movimiento de sprint:", error);
    }
  }

  return { success: true };
});

// NUEVA FUNCIÓN: Generador de Magic Link (Vence en 24h)
resolver.define('generateInviteLink', async (req) => {
  const { accountId } = req.payload;
  const token = Math.random().toString(36).substring(2, 8).toUpperCase();
  
  // Guardamos el token con una marca de tiempo de expiración (24 horas en el futuro)
  const expiresAt = Date.now() + (24 * 60 * 60 * 1000); 
  await kvs.set(`pending_token_${token}`, { accountId, expiresAt });
  
  return token;
});



export const pageResolver = resolver.getDefinitions();

// ─────────────────────────────────────────────────────────
// [API TELEGRAM] HELPER: ENVÍO DE MENSAJES DINÁMICOS
// ─────────────────────────────────────────────────────────
async function sendTelegramMessage(chatId, text, inlineKeyboard = null) {
  // AHORA ES DINÁMICO: Lee el token de la empresa en la que está instalado el plugin
  const token = await kvs.get('telegram_bot_token');
  if (!token) {
    console.error("Intento de envío fallido: No hay bot configurado en este Jira.");
    return;
  }
  
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
    // NUEVO: Agregamos "project" a la petición fields
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,status,project`);
    if (res.status === 200) {
      const data = await res.json();
      return {
        summary: data.fields?.summary || "Sin título",
        status: data.fields?.status?.name || "Desconocido",
        statusId: data.fields?.status?.id || null, 
        category: data.fields?.status?.statusCategory?.key || "new",
        projectKey: data.fields?.project?.key // <-- NUEVO: Clave del proyecto
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

// ─────────────────────────────────────────────────────────
// [API JIRA] HELPER: MOTOR DE SECUENCIA PERSONALIZADA (EL CAMINO IDEAL)
// ─────────────────────────────────────────────────────────
async function getNextForwardTransition(issueKey, projectKey, currentStatusId) {
  try {
    // 1. Obtenemos el "Camino Ideal" configurado por el líder
    const workflowSequence = await kvs.get(`proj_workflow_${projectKey}`);
    
    if (!workflowSequence || workflowSequence.length === 0) {
      console.log(`⚠️ No hay un flujo configurado en Admin para el proyecto ${projectKey}.`);
      return null;
    }

    // 2. Buscamos en qué paso del camino estamos ahora
    const currentIndex = workflowSequence.indexOf(currentStatusId);
    
    // Si la tarea está en un estado que no está en el camino (ej. "Cancelado") o ya llegó al final
    if (currentIndex === -1 || currentIndex >= workflowSequence.length - 1) {
      return null;
    }

    // 3. Calculamos matemáticamente el paso exacto que sigue (+1)
    const nextStatusId = workflowSequence[currentIndex + 1];
    
    // 4. Buscamos la flecha en Jira que nos lleve a ese estado
    const transitions = await getAvailableTransitions(issueKey);
    const targetTransition = transitions.find(t => t.to?.id === nextStatusId);

    return targetTransition || null;

  } catch (error) {
    console.error("Error en motor de secuencia personalizada:", error);
    return null;
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
// [API JIRA] HELPER: TRANSICIÓN DE ESTADO (Blindada)
// ─────────────────────────────────────────────────────────
async function transitionIssue(issueKey, targetIdentifier) {
  if (!targetIdentifier) return false;
  const transitions = await getAvailableTransitions(issueKey);
  
  // Convertimos el dato a string para comparaciones exactas
  const targetStr = targetIdentifier.toString();
  
  // 1. Prioridad: Buscar directamente por el ID de la flecha de transición
  let transition = transitions.find(t => t.id === targetStr);

  // 2. Respaldo: Buscar por el ID del estado al que queremos llegar (to.id)
  if (!transition) {
    transition = transitions.find(t => t.to && t.to.id === targetStr);
  }

  // 3. Último recurso: Buscar por nombre (Mantiene vivo el sweepSubtasks)
  if (!transition) {
    const targetLower = targetStr.trim().toLowerCase();
    transition = transitions.find(
      t => (t.name && t.name.trim().toLowerCase() === targetLower) || 
           (t.to && t.to.name && t.to.name.trim().toLowerCase() === targetLower)
    );
  }

  if (!transition) {
    console.error(`❌ transitionIssue: No se encontró ruta para "${targetStr}" en ${issueKey}`);
    return false;
  }

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
        await agregarComentarioFijo(sub.key, "Subtarea cerrada automáticamente por barrido de la tarea padre (vía Telegram).");
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

  const isActive = await kvs.get(`tg_active_${accountId}`);
  if (isActive === false) return;

  // Mensaje puramente informativo, sin botones de acción
  const mensaje = `*Nueva Asignación*\nHola *${asignadoA}*, se te ha asignado la tarea:\n\n📌 *${issueKey} - ${summary}*`;
  await sendTelegramMessage(chatId, mensaje);
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
        await sendTelegramMessage(chatId, `Registro denegado.\nPídele a tu líder que te envíe un link de invitación.`);
        return { body: "OK", statusCode: 200 };
      }
      
      const tokenIngresado = parts[1].toUpperCase(); 
      const tokenData = await kvs.get(`pending_token_${tokenIngresado}`);

      if (!tokenData) {
        await sendTelegramMessage(chatId, `Enlace inválido o ya utilizado. Pídele a tu líder que genere uno nuevo.`);
        return { body: "OK", statusCode: 200 };
      }

      if (Date.now() > tokenData.expiresAt) {
        await kvs.delete(`pending_token_${tokenIngresado}`);
        await sendTelegramMessage(chatId, `El enlace ha expirado por seguridad. Pídele a tu líder que te genere uno nuevo.`);
        return { body: "OK", statusCode: 200 };
      }

      const accountId = tokenData.accountId;
      await kvs.set(`tg_chat_${accountId}`, chatId);
      await kvs.delete(`pending_token_${tokenIngresado}`);

      const userRes = await api.asApp().requestJira(route`/rest/api/3/user?accountId=${accountId}`);
      const userData = await userRes.json();
      const displayName = userData.displayName || "Usuario";

      await sendTelegramMessage(chatId, `¡Registro exitoso, ${displayName}!\nTu cuenta de Jira está vinculada. Recibirás tus asignaciones aquí.`);
      return { body: "OK", statusCode: 200 };
    }

    if (text.toLowerCase() === 'cancelar') {
      await kvs.delete(`chat_state_${chatId}`);
      await sendTelegramMessage(chatId, `Acción cancelada. El bot está listo para nuevas instrucciones.`);
      return { body: "OK", statusCode: 200 };
    }

    // MEMORIA A CORTO PLAZO (PROCESAMIENTO DE TEXTO)
    const chatState = await kvs.get(`chat_state_${chatId}`);
    if (chatState) {
      const { issueKey, action } = chatState;
      const issueDataAPI = await getIssueData(issueKey);

      let prefijo = action === 'AVANCE' ? "Avance reportado:\n" : "Motivo de retraso:\n";
      const comentarioFinal = `${prefijo}${text}`;

      await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: comentarioFinal }] }] }
        })
      });

      await kvs.delete(`chat_state_${chatId}`);
      await sendTelegramMessage(chatId, `Tu comentario ha sido publicado en:\n*${issueKey} - ${issueDataAPI.summary}*`);
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
      try {
        console.log(`\n▶️ [INICIO ACCIÓN] Comando: ${action} | Tarea: ${issueKey}`);

        // NUEVO FLUJO: Motor de Transición Dinámica (Ágil)
        if (action === 'FORWARD') {
          const nextTransition = await getNextForwardTransition(issueKey, issueDataAPI.projectKey, issueDataAPI.statusId);
          
          if (nextTransition) {
            const isMovingToDone = nextTransition.to?.statusCategory?.key === 'done';
            
            if (isMovingToDone) {
              const openSubtasksCount = await getOpenSubtasksCount(issueKey);
              if (openSubtasksCount > 0) {
                 const warningKeyboard = [
                   [ { text: "Sí, avanzar y barrer subtareas", callback_data: `TG_SWEEPFORWARD_${issueKey}` } ],
                   [ { text: "Cancelar", callback_data: `TG_CANCEL_${issueKey}` } ]
                 ];
                 await sendTelegramMessage(chatId, `Atención: La tarea ${tituloCompleto} tiene ${openSubtasksCount} subtarea(s) en curso.\n\n¿Deseas moverla a "${nextTransition.to?.name}" y finalizar automáticamente sus dependencias?`, warningKeyboard);
                 return { body: "OK", statusCode: 200 };
              }
            }

            const transitionSuccess = await transitionIssue(issueKey, nextTransition.id);
            if (transitionSuccess) {
              await agregarComentarioFijo(issueKey, `Tarea movida a ${nextTransition.to?.name} vía Telegram.`);
              await sendTelegramMessage(chatId, `Excelente. Moví el ticket ${tituloCompleto} a "${nextTransition.to?.name}".`);
            } else {
              await sendTelegramMessage(chatId, `Hubo un problema al intentar mover ${tituloCompleto}. Verifica si tienes permisos en Jira.`);
            }
          } else {
             await sendTelegramMessage(chatId, `No hay transiciones lógicas disponibles para ${tituloCompleto} en el tablero.`);
          }
        }

        // NUEVO FLUJO: Barrido automático acoplado al motor dinámico
        else if (action === 'SWEEPFORWARD') {
           const nextTransition = await getNextForwardTransition(issueKey, issueDataAPI.projectKey, issueDataAPI.statusId);
           if (nextTransition) {
               const transitionSuccess = await transitionIssue(issueKey, nextTransition.id);
               if (transitionSuccess) {
                 const subtasksClosed = await sweepSubtasks(issueKey);
                 const sweepMsg = subtasksClosed > 0 ? `\nBarrido automático: Se cerraron ${subtasksClosed} subtareas asociadas.` : "";
                 await agregarComentarioFijo(issueKey, `Tarea y subtareas movidas en bloque vía Telegram.${sweepMsg}`);
                 await sendTelegramMessage(chatId, `Excelente. Moví el ticket ${tituloCompleto} y sus dependencias a "${nextTransition.to?.name}".${sweepMsg}`);
               } else {
                 await sendTelegramMessage(chatId, `Hubo un problema al intentar mover ${tituloCompleto} y sus subtareas.`);
               }
           }
        }

        // NUEVO FLUJO: El Doble Salto (Lector Visual)
        else if (action === 'DOUBLEJUMP') {
           if (issueDataAPI.category !== 'new') {
               await sendTelegramMessage(chatId, `La tarea ya no se encuentra en su estado inicial. Utiliza las opciones de avance estándar.`);
               return { body: "OK", statusCode: 200 };
           }

           // 1er Salto
           const firstTransition = await getNextForwardTransition(issueKey, issueDataAPI.projectKey, issueDataAPI.statusId);
           if (!firstTransition) {
               await sendTelegramMessage(chatId, `Error de lectura: No fue posible identificar la siguiente etapa estructural para ${tituloCompleto}.`);
               return { body: "OK", statusCode: 200 };
           }

           const firstSuccess = await transitionIssue(issueKey, firstTransition.id);
           if (!firstSuccess) {
               await sendTelegramMessage(chatId, `Error de permisos: Jira rechazó iniciar la tarea ${tituloCompleto}.`);
               return { body: "OK", statusCode: 200 };
           }

           // Tiempo ampliado para permitir la indexación en los servidores de Atlassian Cloud
           await new Promise(resolve => setTimeout(resolve, 2000));

           // 2do Salto
           const secondTransition = await getNextForwardTransition(issueKey, issueDataAPI.projectKey, firstTransition.to.id);
           if (secondTransition) {
               const secondSuccess = await transitionIssue(issueKey, secondTransition.id);
               if (secondSuccess) {
                   await agregarComentarioFijo(issueKey, `Tarea avanzada directamente a "${secondTransition.to?.name}" (Doble salto) vía Telegram.`);
                   await sendTelegramMessage(chatId, `Gestión completada. El ticket ${tituloCompleto} fue avanzado directo a "${secondTransition.to?.name}".`);
               } else {
                   await sendTelegramMessage(chatId, `El ticket inició en "${firstTransition.to?.name}", pero Jira bloqueó la transición a la siguiente etapa.`);
               }
           } else {
               await sendTelegramMessage(chatId, `El ticket avanzó a "${firstTransition.to?.name}", pero no se detectó una etapa posterior disponible de forma automática.`);
           }
        }

        // NUEVO FLUJO: Reportar avances
        else if (action === 'AVANCE') {
          if (issueDataAPI.category === 'new') {
            const nextTransition = await getNextForwardTransition(issueKey, issueDataAPI.projectKey, issueDataAPI.statusId);
            if (nextTransition) {
              await transitionIssue(issueKey, nextTransition.id);
            }
          }
          await kvs.set(`chat_state_${chatId}`, { issueKey, action: 'AVANCE' });
          await sendTelegramMessage(chatId, `¿Qué avances lograste en:\n${tituloCompleto}?\n\nEscríbelo en un mensaje y lo registraré.\n_(Escribe "cancelar" para abortar)_`);
        } 
        
        else if (action === 'SINAVANCE') {
          const subMenuKeyboard = [
            [ { text: "Reportar problema", callback_data: `TG_PROBLEMA_${issueKey}` } ],
            [ { text: "Sin problemas", callback_data: `TG_SINPROBLEMA_${issueKey}` } ]
          ];
          await sendTelegramMessage(chatId, `¿Hay algún problema o bloqueo con:\n${tituloCompleto}?\n\nSelecciona una opción:`, subMenuKeyboard);
        }

        else if (action === 'PROBLEMA') {
          await kvs.set(`chat_state_${chatId}`, { issueKey, action: 'PROBLEMA' });
          await sendTelegramMessage(chatId, `Entendido. ¿Cuál es el problema con:\n${tituloCompleto}?\n\nEscríbelo abajo para dejar el registro en Jira.\n_(Escribe "cancelar" para abortar)_`);
        }

        else if (action === 'SINPROBLEMA') {
          await sendTelegramMessage(chatId, `Entendido. Tarea ${issueKey} sin novedades por hoy.`);
        }

        else if (action === 'CANCEL') {
          await kvs.delete(`chat_state_${chatId}`);
          await sendTelegramMessage(chatId, `Acción cancelada.`);
        }

      } catch (error) {
        console.error(`❌ [ERROR CRÍTICO] Acción: ${action} | Tarea: ${issueKey}`);
        console.error(error);
        await sendTelegramMessage(chatId, `⚠️ Ups, ocurrió un error interno al intentar procesar tu solicitud.`);
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

// ─────────────────────────────────────────────────────────
// [WEBHOOKS] 3. EVENTO PROGRAMADO (CRON): REPORTES Y DIGESTS
// ─────────────────────────────────────────────────────────
export async function runScheduledPings(event, context, isForced = false, targetAccountId = null, targetProjectKey = null, runType = 'ALL') {
  console.log(`⏰ Ejecutando revisión. (Forzado: ${isForced}, Tipo: ${runType})`);

  const chileTime = new Date().toLocaleString("en-US", { timeZone: "America/Santiago", hour12: false });
  const currentHour = new Date(chileTime).getHours();
  const currentDay = new Date(chileTime).getDay(); 

  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' });
  const todayStr = formatter.format(new Date());

  const projRes = await api.asApp().requestJira(route`/rest/api/3/project`);
  if (projRes.status !== 200) return;
  const projects = await projRes.json();

  // NUEVO: Obtener la URL base de tu Jira para armar los links
  const serverInfoRes = await api.asApp().requestJira(route`/rest/api/3/serverInfo`);
  let baseUrl = "";
  if (serverInfoRes.status === 200) {
    const serverInfo = await serverInfoRes.json();
    baseUrl = serverInfo.baseUrl;
  }

  for (const proj of projects) {
    if (targetProjectKey && proj.key !== targetProjectKey) continue;

    const mode = await kvs.get(`proj_mode_${proj.key}`) || 'SCRUM';
    const leaderTimeStr = await kvs.get(`proj_time_${proj.key}`) || '17:00';
    const leaderHour = parseInt(leaderTimeStr.split(':')[0], 10);

    let jqlQuery = `project = "${proj.key}" AND (resolution = Unresolved OR resolved >= -1d) AND assignee IS NOT EMPTY`;
    if (mode === 'SCRUM') {
      jqlQuery += ` AND sprint IN openSprints()`;
    }
    if (targetAccountId && runType === 'EXECUTOR') {
      jqlQuery += ` AND assignee = "${targetAccountId}"`;
    }

    const payload = {
      jql: jqlQuery,
      fields: ["summary", "status", "assignee", "issuelinks", "startdate", "customfield_10015", "duedate", "updated"],
      maxResults: 100
    };

    const searchRes = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const data = await searchRes.json();
    const validTasks = [];
    const userTasks = {};

    if (data.issues && data.issues.length > 0) {
      for (const issue of data.issues) {
        const assignee = issue.fields.assignee;
        
        const startDateStr = issue.fields.startdate || issue.fields.customfield_10015;
        if (startDateStr) {
          const taskDate = startDateStr.substring(0, 10);
          if (taskDate > todayStr) continue; 
        }

        let isBlocked = false;
        if (issue.fields.issuelinks) {
          for (const link of issue.fields.issuelinks) {
            if (link.type.name === "Blocks" && link.inwardIssue) {
              const statusCategory = link.inwardIssue.fields?.status?.statusCategory?.key;
              if (statusCategory !== 'done') { isBlocked = true; break; }
            }
          }
        }
        if (isBlocked) continue; 

        // 1. Guardamos TODAS las tareas (incluyendo las terminadas) para el reporte del líder
        validTasks.push(issue);

        // 2. Evaluamos si está terminada
        const isDone = issue.fields.resolution || issue.fields.status?.statusCategory?.key === 'done';
        
        // 3. SOLO agregamos a la lista del ejecutor si NO está terminada
        if (!isDone) {
          if (!userTasks[assignee.accountId]) {
            userTasks[assignee.accountId] = { displayName: assignee.displayName, issues: [] };
          }
          userTasks[assignee.accountId].issues.push(issue);
        }
      }
    }

    // 3. FLUJO A: MENSAJES A LOS EJECUTORES (Limpios y Cordiales)
    if (runType === 'ALL' || runType === 'EXECUTOR') {
      for (const [accountId, userData] of Object.entries(userTasks)) {
        const chatId = await kvs.get(`tg_chat_${accountId}`);
        if (!chatId) continue; 

        const isActive = await kvs.get(`tg_active_${accountId}`);
        if (isActive === false) continue;
        
        const reportTime = await kvs.get(`tg_time_${accountId}`) || "17:00";
        const reportDays = await kvs.get(`tg_days_${accountId}`) || [1, 2, 3, 4, 5];
        const reportHour = parseInt(reportTime.split(':')[0], 10);

        if (!isForced && !reportDays.includes(currentDay)) continue;

        if (reportHour === currentHour || isForced) {
          await sendTelegramMessage(chatId, `Hola ${userData.displayName}, es hora de revisar tus tareas asignadas:`);
          for (const issue of userData.issues) {
            let timeStatus = "";
            if (issue.fields.duedate) {
              timeStatus = ` | Vence: ${issue.fields.duedate}`;
              if (issue.fields.duedate < todayStr) timeStatus += " (Atrasada)";
              else if (issue.fields.duedate === todayStr) timeStatus += " (Vence hoy)";
            }

            // 1. Extraemos la categoría y el nombre actual
            const statusCategory = issue.fields.status?.statusCategory?.key || 'new';
            const statusName = issue.fields.status?.name || 'Desconocido';
            
            // 2. Consultamos al motor lógico cuál es el siguiente paso
            const nextTransition = await getNextForwardTransition(issue.key, proj.key, issue.fields.status?.id);

            // 3. Armamos la base inamovible de los 2 primeros botones
            const taskKeyboard = [
              [ { text: "Con avances", callback_data: `TG_AVANCE_${issue.key}` } ],
              [ { text: "Sin avances", callback_data: `TG_SINAVANCE_${issue.key}` } ]
            ];

            // 4. Construcción dinámica del TERCER botón
            if (statusCategory === 'new') {
               // ESCENARIO A (En To Do): No sabemos el nombre de la etapa 3 aún, usamos texto genérico.
               taskKeyboard.push([ { text: "Avanzar a siguiente etapa", callback_data: `TG_DOUBLEJUMP_${issue.key}` } ]);
            } 
            else if (nextTransition) {
               // ESCENARIO B (En Doing): Jira sí nos deja ver la siguiente etapa real.
               let stageName = nextTransition.to.name;
               if (stageName.length > 15) stageName = stageName.substring(0, 15) + "...";
               taskKeyboard.push([ { text: `Mover a ${stageName}`, callback_data: `TG_FORWARD_${issue.key}` } ]);
            } 
            else if (statusCategory === 'indeterminate') {
               // Fallback: Si no hay transiciones intermedias hacia adelante
               taskKeyboard.push([ { text: "Marcar como Terminada", callback_data: `TG_FORWARD_${issue.key}` } ]);
            }

            const summaryLink = `[${issue.fields.summary}](${baseUrl}/browse/${issue.key})`;
            await sendTelegramMessage(chatId, `↳ *${issue.key}* - ${summaryLink}\n_Estado: ${statusName}${timeStatus}_`, taskKeyboard);
          }
        }
      }
    }

    // 4. FLUJO B: REPORTE EJECUTIVO A LOS LÍDERES (Con formato visual y Emojis)
    if (runType === 'ALL' || runType === 'LEADER') {
      if (leaderHour === currentHour || isForced) {
        
        const resUsers = await api.asApp().requestJira(route`/rest/api/3/user/assignable/search?project=${proj.key}`);
        const allAssignables = await resUsers.json();
        const leaderChatIds = [];
        
        for (const u of allAssignables) {
          const isL = await kvs.get(`tg_leader_${proj.key}_${u.accountId}`);
          if (isL) {
            const chat = await kvs.get(`tg_chat_${u.accountId}`);
            if (chat) leaderChatIds.push(chat);
          }
        }

        if (leaderChatIds.length > 0) {
          if (validTasks.length === 0) {
            const emptyMsg = mode === 'SCRUM' 
              ? `⭘ *Sin Novedades en ${proj.name}*\nNo hay tareas en un Sprint activo que requieran seguimiento hoy.`
              : `⭘ *Sin Novedades en ${proj.name}*\nEl tablero está vacío o todas las tareas están bloqueadas/en el futuro.`;
            for (const chat of leaderChatIds) await sendTelegramMessage(chat, emptyMsg);
            continue;
          }

          const terminadas = []; 
          const atrasadas = []; const problemas = []; const avances = []; const sinNovedades = [];
          const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

          for (const issue of validTasks) {
            const name = issue.fields.assignee?.displayName.split(' ')[0] || "Alguien";
            
            // NUEVO: Formatear la fecha de vencimiento a (V: DD-MM-YYYY)
            let dueText = "";
            if (issue.fields.duedate) {
              const [yyyy, mm, dd] = issue.fields.duedate.split('-');
              dueText = ` (V: ${dd}-${mm}-${yyyy})`;
            }
            
            // Agregamos dueText al lado del nombre en cada categoría y usamos el ícono ↳
            if (issue.fields.resolution || issue.fields.status?.statusCategory?.key === 'done') {
              terminadas.push(`↳ *${issue.key}* - _${name}_${dueText}`);
              continue; 
            }

            if (issue.fields.duedate && issue.fields.duedate < todayStr) atrasadas.push(`↳ *${issue.key}* - _${name}_${dueText}\n    Venció el ${issue.fields.duedate}`);

            const updatedDate = new Date(issue.fields.updated);
            if (updatedDate > yesterday) {
              const comRes = await api.asApp().requestJira(route`/rest/api/3/issue/${issue.key}/comment?orderBy=-created&maxResults=5`);
              const comData = await comRes.json();
              let categorized = false;

              if (comData.comments) {
                for (const c of comData.comments) {
                  const cDate = new Date(c.created);
                  if (cDate > yesterday) {
                    const text = c.body?.content?.[0]?.content?.[0]?.text || "";
                    if (text.includes("Motivo de retraso:") || text.includes("Problema reportado:")) {
                      problemas.push(`↳ *${issue.key}* - _${name}_${dueText}\n    💬 _"${text.split('\n').pop()}"_`);
                      categorized = true; break;
                    }
                    if (text.includes("Avance reportado:")) {
                      avances.push(`↳ *${issue.key}* - _${name}_${dueText}\n    💬 _"${text.split('\n').pop()}"_`);
                      categorized = true; break;
                    }
                  }
                }
              }
              if (!categorized) sinNovedades.push(`↳ *${issue.key}* - _${name}_${dueText}`);
            } else {
              sinNovedades.push(`↳ *${issue.key}* - _${name}_${dueText}`);
            }
          }

          // NUEVO: Hipervínculo directo y estética monocromática sin monospace
          let digestMsg = `📊 *Reporte Diario de Gestión:* [${proj.name}](${baseUrl}/browse/${proj.key})\n_Últimas 24 horas_\n\n`;
          
          digestMsg += `✓  Terminadas:       ${terminadas.length}\n`;
          digestMsg += `⬈  Avances:             ${avances.length}\n`;
          digestMsg += `⊘  Problemas:         ${problemas.length}\n`;
          digestMsg += `◬  Atrasadas:          ${atrasadas.length}\n`;
          digestMsg += `⭘  Sin Novedades:  ${sinNovedades.length}\n\n`;
          
          if (terminadas.length > 0) digestMsg += `*✓ TERMINADAS HOY*\n${terminadas.join('\n')}\n\n`;
          if (avances.length > 0) digestMsg += `*⬈ AVANCES*\n${avances.join('\n')}\n\n`;
          if (problemas.length > 0) digestMsg += `*⊘ PROBLEMAS Y BLOQUEOS*\n${problemas.join('\n')}\n\n`;
          if (atrasadas.length > 0) digestMsg += `*◬ ATRASADAS*\n${atrasadas.join('\n')}\n\n`;
          if (sinNovedades.length > 0) digestMsg += `*⭘ SIN NOVEDADES HOY*\n${sinNovedades.join('\n')}`;

          for (const chat of leaderChatIds) await sendTelegramMessage(chat, digestMsg);
        }
      }
    }
  }
}
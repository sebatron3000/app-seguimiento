import React, { useState, useEffect } from 'react';
import ForgeReconciler, { Text, Stack, Heading, Spinner, Button, InlineMessage, DynamicTable, SectionMessage, Select, Inline, Tag, Toggle } from '@forge/react';
import { invoke, view } from '@forge/bridge';

const WEEK_DAYS = [
  { id: 1, label: 'L' }, { id: 2, label: 'M' }, { id: 3, label: 'M' },
  { id: 4, label: 'J' }, { id: 5, label: 'V' }, { id: 6, label: 'S' }, { id: 0, label: 'D' }
];

const TIME_OPTIONS = Array.from({ length: 24 }, (_, i) => {
  const timeString = `${i.toString().padStart(2, '0')}:00`;
  return { label: timeString, value: timeString };
});

const MODE_OPTIONS = [
  { label: 'Scrum (Sprints)', value: 'SCRUM' },
  { label: 'Kanban (Flujo Continuo)', value: 'KANBAN' }
];

const AdminPanel = () => {
  const [users, setUsers] = useState(null);
  const [editingUser, setEditingUser] = useState(null);
  const [newTime, setNewTime] = useState("");
  const [newDays, setNewDays] = useState([]);
  const [context, setContext] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  
  const [hasAccess, setHasAccess] = useState(null);
  
  const [projectMode, setProjectMode] = useState("SCRUM");
  const [leaderTime, setLeaderTime] = useState("17:00");

  const [projectStatuses, setProjectStatuses] = useState([]);
  const [workflowSequence, setWorkflowSequence] = useState([]);
  const [statusToAdd, setStatusToAdd] = useState(null);

  useEffect(() => {
    view.getContext().then(setContext);
    
    invoke('checkAdminAccess').then(res => {
      setHasAccess(res.hasAccess);
      if (res.hasAccess) {
        fetchData(); 
      }
    });
  }, []);

  const fetchData = async () => {
    setUsers(null);
    
    const usersData = await invoke('getProjectUsers');
    setUsers(usersData);
    
    const configData = await invoke('getProjectConfig');
    if (configData) {
      setProjectMode(configData.mode || "SCRUM");
      setLeaderTime(configData.leaderTime || "17:00");
    }

    const statusesData = await invoke('getProjectStatuses');
    setProjectStatuses(statusesData || []);

    const sequenceData = await invoke('getWorkflowSequence');
    
    if (sequenceData && sequenceData.length > 0) {
      setWorkflowSequence(sequenceData);
    } else if (statusesData && statusesData.length > 0) {
      setWorkflowSequence(statusesData.map(s => s.id));
    } else {
      setWorkflowSequence([]);
    }
  };

  const handleSaveGlobalConfig = async () => {
    const projectKey = context?.extension?.project?.key;
    await invoke('saveProjectConfig', { projectKey, mode: projectMode, leaderTime: leaderTime });
    setSuccessMsg("Configuración global del proyecto guardada.");
    setTimeout(() => setSuccessMsg(null), 5000);
  };

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const newWf = [...workflowSequence];
    [newWf[index - 1], newWf[index]] = [newWf[index], newWf[index - 1]];
    setWorkflowSequence(newWf);
  };

  const handleMoveDown = (index) => {
    if (index === workflowSequence.length - 1) return;
    const newWf = [...workflowSequence];
    [newWf[index + 1], newWf[index]] = [newWf[index], newWf[index + 1]];
    setWorkflowSequence(newWf);
  };

  const handleRemoveStep = (index) => {
    const newWf = [...workflowSequence];
    newWf.splice(index, 1);
    setWorkflowSequence(newWf);
  };

  const handleAddStep = () => {
    if (statusToAdd && !workflowSequence.includes(statusToAdd)) {
      setWorkflowSequence([...workflowSequence, statusToAdd]);
      setStatusToAdd(null);
    }
  };

  const handleSaveWorkflow = async () => {
    await invoke('saveWorkflowSequence', { sequence: workflowSequence });
    setSuccessMsg("Ruta de trabajo guardada exitosamente.");
    setTimeout(() => setSuccessMsg(null), 5000);
  };

  const getStatusName = (id) => {
    const s = projectStatuses.find(st => st.id === id);
    return s ? s.name : `Desconocido (${id})`;
  };

  const availableStatuses = projectStatuses
    .filter(s => !workflowSequence.includes(s.id))
    .map(s => ({ label: s.name, value: s.id }));

  const workflowHead = {
    cells: [
      { key: 'step', content: 'Paso' },
      { key: 'status', content: 'Estado en Jira' },
      { key: 'actions', content: 'Acciones de Orden' },
    ]
  };

  const workflowRows = workflowSequence.map((statusId, index) => ({
    key: statusId || `step-${index}`,
    cells: [
      { key: 'step', content: <Text weight="bold">{index + 1}</Text> },
      { key: 'status', content: <Text>{getStatusName(statusId)}</Text> },
      { key: 'actions', content: (
          <Inline space="space.100">
            <Button appearance="subtle" onClick={() => handleMoveUp(index)} isDisabled={index === 0}>Subir</Button>
            <Button appearance="subtle" onClick={() => handleMoveDown(index)} isDisabled={index === workflowSequence.length - 1}>Bajar</Button>
            <Button appearance="subtle" onClick={() => handleRemoveStep(index)}>Quitar</Button>
          </Inline>
        ) 
      },
    ]
  }));

  const handleToggleLeader = async (user) => {
    const projectKey = context?.extension?.project?.key;
    const newStatus = !user.isLeader;
    await invoke('toggleLeaderRole', { projectKey, accountId: user.accountId, isLeader: newStatus });
    setSuccessMsg(`Privilegios de ${user.displayName} actualizados.`);
    setTimeout(() => setSuccessMsg(null), 3000);
    fetchData();
  };

  const handleToggleActive = async (user, isChecked) => {
    await invoke('toggleUserActiveStatus', { accountId: user.accountId, isActive: isChecked });
    setSuccessMsg(isChecked ? `Notificaciones activadas para ${user.displayName}.` : `Notificaciones silenciadas para ${user.displayName}.`);
    setTimeout(() => setSuccessMsg(null), 3000);
    fetchData(); 
  };

  const startEdit = (userOrGlobal) => {
    setEditingUser(userOrGlobal);
    if (userOrGlobal === "GLOBAL") {
      setNewTime("17:00");
      setNewDays([1, 2, 3, 4, 5]);
    } else {
      setNewTime(userOrGlobal.reportTime);
      setNewDays(userOrGlobal.reportDays);
    }
  };

  const toggleDay = (dayId) => {
    if (newDays.includes(dayId)) setNewDays(newDays.filter(d => d !== dayId));
    else setNewDays([...newDays, dayId]);
  };

  const handleSave = async () => {
    const isGlobal = editingUser === "GLOBAL";
    const projectKey = context?.extension?.project?.key;
    await invoke('updateReportTime', {
      accountId: isGlobal ? null : editingUser.accountId,
      newTime: newTime,
      newDays: newDays,
      isGlobal: isGlobal,
      projectKey: projectKey
    });
    setEditingUser(null);
    fetchData();
  };

  const handleInviteTask = async (user) => {
    const projectKey = context?.extension?.project?.key;
    await invoke('createInviteTask', { accountId: user.accountId, projectKey });
    setSuccessMsg(`Tarea de invitación asignada a ${user.displayName}.`);
    setTimeout(() => setSuccessMsg(null), 5000);
  };

  const handleTestReport = async (user) => {
    const projectKey = context?.extension?.project?.key; // <- Ahora sí sabe que es este proyecto Kanban
    await invoke('triggerManualPings', { accountId: user.accountId, projectKey: projectKey, type: 'EXECUTOR' });
    setSuccessMsg(`Reporte de prueba enviado a ${user.displayName}.`);
    setTimeout(() => setSuccessMsg(null), 5000);
  };

  const handleTestLeaderDigest = async () => {
    const projectKey = context?.extension?.project?.key;
    await invoke('triggerManualPings', { projectKey, type: 'LEADER' });
    setSuccessMsg(`Reporte Ejecutivo de prueba enviado a los líderes.`);
    setTimeout(() => setSuccessMsg(null), 5000);
  };

  if (hasAccess === null) return <Spinner size="large" />;

  if (hasAccess === false) {
    return (
      <Stack space="space.300">
        <SectionMessage appearance="error" title="Acceso Denegado">
          <Text>No tienes los permisos necesarios para ver o modificar la configuración de PMBot Admin. Para acceder a este panel, debes ser designado como Líder de este proyecto.</Text>
        </SectionMessage>
      </Stack>
    );
  }

  if (!context || !users) return <Spinner size="large" />;

  if (editingUser) {
    const isGlobal = editingUser === "GLOBAL";
    const title = isGlobal ? "Modificar Horario de Todo el Equipo" : `Modificar Horario de ${editingUser.displayName}`;
    
    return (
      <Stack space="space.200">
        <Heading as="h3">{title}</Heading>
        {isGlobal && <InlineMessage appearance="warning"><Text>Esto sobrescribirá los horarios personalizados de todos los integrantes.</Text></InlineMessage>}
        <Stack space="space.100">
          <Text weight="bold">Días de Reporte:</Text>
          <Inline space="space.050">
            {WEEK_DAYS.map(day => (
              <Button key={day.id} appearance={newDays.includes(day.id) ? "primary" : "default"} onClick={() => toggleDay(day.id)}>
                {day.label}
              </Button>
            ))}
          </Inline>
        </Stack>
        <Inline space="space.100" alignBlock="center">
          <Text weight="bold">Hora de Reporte:</Text>
          <Select options={TIME_OPTIONS} value={TIME_OPTIONS.find(opt => opt.value === newTime)} onChange={(opt) => setNewTime(opt.value)} />
        </Inline>
        <Inline space="space.100">
          <Button appearance="primary" onClick={handleSave}>Guardar Cambios</Button>
          <Button onClick={() => setEditingUser(null)}>Cancelar</Button>
        </Inline>
      </Stack>
    );
  }

  const formatDays = (daysArray) => WEEK_DAYS.filter(d => daysArray.includes(d.id)).map(d => d.label).join(' - ');

  const head = {
    cells: [
      { key: 'name', content: 'Integrante' },
      { key: 'role', content: 'Rol' },
      { key: 'status', content: 'Telegram' },
      { key: 'days', content: 'Días' },
      { key: 'time', content: 'Hora' },
      { key: 'actions', content: 'Acciones' },
    ]
  };

  const rows = users.map(user => ({
    key: user.accountId,
    cells: [
      { key: 'name', content: user.displayName },
      { key: 'role', content: user.isLeader ? <Tag text="Líder" color="purple" /> : <Tag text="Ejecutor" /> },
      { key: 'status', content: user.isSynced ? (
          <Inline>
            <Toggle 
              id={`toggle-${user.accountId}`} 
              size="regular" 
              isChecked={user.isActive} 
              onChange={(e) => handleToggleActive(user, e.target.checked)}
            />
          </Inline>
        ) : (
          <Text color="color.text.subtlest">No vinculado</Text>
        ) 
      },
      { key: 'days', content: formatDays(user.reportDays) },
      { key: 'time', content: user.reportTime },
      { key: 'actions', content: (
          <Inline space="space.100">
            <Button onClick={() => startEdit(user)}>Editar</Button>
            <Button onClick={() => handleToggleLeader(user)}>{user.isLeader ? "Quitar Líder" : "Hacer Líder"}</Button>
            
            {!user.isSynced && <Button appearance="discovery" onClick={() => handleInviteTask(user)}>Invitar</Button>}
            
            {/* NUEVO: Permite re-generar invitación para usuarios que quedaron atrapados en la arquitectura antigua */}
            {user.isSynced && <Button appearance="subtle" onClick={() => handleInviteTask(user)}>Re-vincular</Button>}
            
            {user.isSynced && <Button onClick={() => handleTestReport(user)}>Probar</Button>}
          </Inline>
        ) 
      },
    ]
  }));

  return (
    <Stack space="space.300">
      
      {successMsg && <SectionMessage appearance="success"><Text>{successMsg}</Text></SectionMessage>}

      <Stack space="space.200">
        <Heading as="h3">Configuración del Proyecto</Heading>
        <Inline space="space.200" alignBlock="center">
          <Text>Modalidad:</Text>
          <Select options={MODE_OPTIONS} value={MODE_OPTIONS.find(opt => opt.value === projectMode)} onChange={(opt) => setProjectMode(opt.value)} />
          <Text>Hora Reporte Ejecutivo (Líderes):</Text>
          <Select options={TIME_OPTIONS} value={TIME_OPTIONS.find(opt => opt.value === leaderTime)} onChange={(opt) => setLeaderTime(opt.value)} />
          <Button appearance="primary" onClick={handleSaveGlobalConfig}>Guardar Ajustes</Button>
          <Button onClick={handleTestLeaderDigest}>Forzar Reporte a Líder</Button>
        </Inline>
      </Stack>

      <Stack space="space.200" />

      <Stack space="space.200">
        <Heading as="h3">Ruta de Trabajo Lineal</Heading>
        <Text>Define la secuencia exacta por la que avanzarán las tareas. Los estados omitidos requerirán ser gestionados manualmente en Jira.</Text>

        {workflowSequence.length === 0 && (
          <SectionMessage appearance="warning">
            <Text>No hay una ruta definida. PMBot no ejecutará avances automáticos hasta que se guarde la configuración.</Text>
          </SectionMessage>
        )}

        <Inline space="space.100" alignBlock="center">
          <Select 
            placeholder="Selecciona un estado..."
            options={availableStatuses} 
            value={availableStatuses.find(opt => opt.value === statusToAdd) || null} 
            onChange={(opt) => setStatusToAdd(opt ? opt.value : null)} 
          />
          <Button appearance="primary" onClick={handleAddStep} isDisabled={!statusToAdd}>Añadir estado</Button>
          <Button appearance="discovery" onClick={handleSaveWorkflow}>Guardar Ruta Definitiva</Button>
        </Inline>

        <DynamicTable head={workflowHead} rows={workflowRows} />
      </Stack>

      <Stack space="space.200" />

      <Stack space="space.200">
        <Heading as="h3">Equipo e Integrantes</Heading>
        <Inline space="space.100">
          <Button appearance="primary" onClick={() => startEdit("GLOBAL")}>Horario masivo (Ejecutores)</Button>
          <Button onClick={async () => { await invoke('triggerManualPings', { type: 'EXECUTOR' }); setSuccessMsg("Reportes masivos enviados."); setTimeout(() => setSuccessMsg(null), 5000); }}>
            Forzar Notificaciones
          </Button>
        </Inline>
        <DynamicTable head={head} rows={rows} />
      </Stack>

    </Stack>
  );
};

ForgeReconciler.render(<AdminPanel />);
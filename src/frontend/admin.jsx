import React, { useState, useEffect } from 'react';
import ForgeReconciler, { Text, Stack, Heading, Spinner, Button, InlineMessage, DynamicTable, SectionMessage, Select, Inline, Tag } from '@forge/react';
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
  
  // NUEVO: Estado para controlar la puerta de seguridad
  const [hasAccess, setHasAccess] = useState(null);
  
  const [projectMode, setProjectMode] = useState("SCRUM");
  const [leaderTime, setLeaderTime] = useState("17:00");

  useEffect(() => {
    view.getContext().then(setContext);
    
    // Verificamos credenciales antes de cargar cualquier dato sensible
    invoke('checkAdminAccess').then(res => {
      setHasAccess(res.hasAccess);
      if (res.hasAccess) {
        fetchData(); // Solo si tiene permiso, traemos los datos de la base
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
  };

  const handleSaveGlobalConfig = async () => {
    const projectKey = context?.extension?.project?.key;
    await invoke('saveProjectConfig', { projectKey, mode: projectMode, leaderTime: leaderTime });
    setSuccessMsg("✅ Configuración global del proyecto guardada.");
    setTimeout(() => setSuccessMsg(null), 5000);
  };

  const handleToggleLeader = async (user) => {
    const projectKey = context?.extension?.project?.key;
    const newStatus = !user.isLeader;
    await invoke('toggleLeaderRole', { projectKey, accountId: user.accountId, isLeader: newStatus });
    setSuccessMsg(`👑 Privilegios de ${user.displayName} actualizados.`);
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
    setSuccessMsg(`✅ Tarea de invitación asignada a ${user.displayName}.`);
    setTimeout(() => setSuccessMsg(null), 5000);
  };

  const handleTestReport = async (user) => {
    await invoke('triggerManualPings', { accountId: user.accountId, type: 'EXECUTOR' });
    setSuccessMsg(`🔔 Reporte de prueba enviado a ${user.displayName}.`);
    setTimeout(() => setSuccessMsg(null), 5000);
  };

  const handleTestLeaderDigest = async () => {
    const projectKey = context?.extension?.project?.key;
    await invoke('triggerManualPings', { projectKey, type: 'LEADER' });
    setSuccessMsg(`📊 Reporte Ejecutivo de prueba enviado a los líderes.`);
    setTimeout(() => setSuccessMsg(null), 5000);
  };

  // ----------------------------------------------------
  // PANTALLAS DE CARGA Y BLOQUEO DE SEGURIDAD
  // ----------------------------------------------------
  if (hasAccess === null) return <Spinner size="large" />;

  if (hasAccess === false) {
    return (
      <Stack space="space.300">
        <Heading as="h2">👥 Panel de Control: Telegram Sync</Heading>
        <SectionMessage appearance="error" title="Acceso Denegado">
          <Text>No tienes los permisos necesarios para ver o modificar la configuración de Telegram Sync. Para acceder a este panel, debes ser designado como **Líder** de este proyecto.</Text>
        </SectionMessage>
      </Stack>
    );
  }

  if (!context || !users) return <Spinner size="large" />;

  // ----------------------------------------------------
  // PANTALLA DE EDICIÓN INDIVIDUAL
  // ----------------------------------------------------
  if (editingUser) {
    const isGlobal = editingUser === "GLOBAL";
    const title = isGlobal ? "Modificar Horario de Todo el Equipo" : `Modificar Horario de ${editingUser.displayName}`;
    
    return (
      <Stack space="space.200">
        <Heading as="h3">⏱️ {title}</Heading>
        {isGlobal && <InlineMessage appearance="warning"><Text>Esto sobrescribirá los horarios personalizados de todos.</Text></InlineMessage>}
        <Stack space="space.100">
          <Text>**Días de Reporte:**</Text>
          <Inline space="space.050">
            {WEEK_DAYS.map(day => (
              <Button key={day.id} appearance={newDays.includes(day.id) ? "primary" : "default"} onClick={() => toggleDay(day.id)}>
                {day.label}
              </Button>
            ))}
          </Inline>
        </Stack>
        <Inline space="space.100" alignBlock="center">
          <Text>**Hora de Reporte:**</Text>
          <Select options={TIME_OPTIONS} value={TIME_OPTIONS.find(opt => opt.value === newTime)} onChange={(opt) => setNewTime(opt.value)} />
        </Inline>
        <Inline space="space.100">
          <Button appearance="primary" onClick={handleSave}>Guardar Cambios</Button>
          <Button onClick={() => setEditingUser(null)}>Cancelar</Button>
        </Inline>
      </Stack>
    );
  }

  // ----------------------------------------------------
  // TABLA PRINCIPAL Y CONFIGURACIÓN GLOBAL
  // ----------------------------------------------------
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
      { key: 'role', content: user.isLeader ? <Tag text="👑 Líder" color="purple" /> : <Tag text="👷 Ejecutor" /> },
      { key: 'status', content: user.isSynced ? "✅" : "❌" },
      { key: 'days', content: formatDays(user.reportDays) },
      { key: 'time', content: user.reportTime },
      { key: 'actions', content: (
          <Inline space="space.100">
            <Button onClick={() => startEdit(user)}>Editar</Button>
            <Button onClick={() => handleToggleLeader(user)}>{user.isLeader ? "Quitar Líder" : "Hacer Líder"}</Button>
            {!user.isSynced && <Button appearance="discovery" onClick={() => handleInviteTask(user)}>Invitar</Button>}
            {user.isSynced && <Button onClick={() => handleTestReport(user)}>Probar</Button>}
          </Inline>
        ) 
      },
    ]
  }));

  return (
    <Stack space="space.300">
      <Heading as="h2">👥 Panel de Control: Telegram Sync</Heading>
      
      {successMsg && <SectionMessage appearance="success"><Text>{successMsg}</Text></SectionMessage>}

      <Stack space="space.200">
        <Heading as="h3">⚙️ Configuración del Proyecto</Heading>
        <Inline space="space.200" alignBlock="center">
          <Text>**Modalidad:**</Text>
          <Select options={MODE_OPTIONS} value={MODE_OPTIONS.find(opt => opt.value === projectMode)} onChange={(opt) => setProjectMode(opt.value)} />
          <Text>**Hora Reporte Ejecutivo (Líderes):**</Text>
          <Select options={TIME_OPTIONS} value={TIME_OPTIONS.find(opt => opt.value === leaderTime)} onChange={(opt) => setLeaderTime(opt.value)} />
          <Button appearance="primary" onClick={handleSaveGlobalConfig}>Guardar Ajustes</Button>
          <Button onClick={handleTestLeaderDigest}>Probar Digest</Button>
        </Inline>
      </Stack>

      <Stack space="space.200" />

      <Stack space="space.200">
        <Heading as="h3">👥 Equipo e Integrantes</Heading>
        <Inline space="space.100">
          <Button appearance="primary" onClick={() => startEdit("GLOBAL")}>⏰ Horario a todos (Ejecutores)</Button>
          <Button onClick={async () => { await invoke('triggerManualPings', { type: 'EXECUTOR' }); setSuccessMsg("¡Reportes masivos enviados!"); setTimeout(() => setSuccessMsg(null), 5000); }}>
            🔔 Forzar Pings
          </Button>
        </Inline>
        <DynamicTable head={head} rows={rows} />
      </Stack>

    </Stack>
  );
};

ForgeReconciler.render(<AdminPanel />);
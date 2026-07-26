import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import ForgeReconciler, {
  Text,
  Select,
  Stack,
  Inline,
  Box,
  Heading,
  DynamicTable,
  Button,
  Textfield,
  SectionMessage,
  xcss
} from '@forge/react';

// Estilo de tarjetas
const cardStyle = xcss({
  backgroundColor: 'elevation.surface.raised',
  padding: 'space.300',
  boxShadow: 'elevation.shadow.raised',
  borderWidth: 'border.width',
  borderColor: 'color.border',
  borderStyle: 'solid',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  flex: '1 1 0',
  maxWidth: '280px'
});

const filterBoxStyle = xcss({ minWidth: '220px' });

const centerText = (text, isBold = false) => (
  <Box xcss={xcss({ display: 'flex', justifyContent: 'center', textAlign: 'center', width: '100%' })}>
    <Text weight={isBold ? "bold" : "regular"}>{text}</Text>
  </Box>
);

const App = () => {
  // Estados de Onboarding
  const [isConfigured, setIsConfigured] = useState(false);
  const [isLoadingSetup, setIsLoadingSetup] = useState(true);
  const [inputToken, setInputToken] = useState('');
  const [setupError, setSetupError] = useState(null);
  const [isValidating, setIsValidating] = useState(false);

  // Estados del Dashboard
  const [selectedProjects, setSelectedProjects] = useState([]);
  const [timeGrouping, setTimeGrouping] = useState('semanas');
  const [selectedCohort, setSelectedCohort] = useState('all');
  const [projectOptions, setProjectOptions] = useState([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [isApplying, setIsApplying] = useState(false);
  const [summaryData, setSummaryData] = useState({ interacciones: 0, estancadas: 0, eficiencia: 'N/A' });
  const [tableDataRaw, setTableDataRaw] = useState([]);

  useEffect(() => {
    // 1. Verificamos si la empresa ya configuró su Bot
    invoke('getBotSetup').then((res) => {
      setIsConfigured(res.isSetup);
      setIsLoadingSetup(false);
      
      // Si ya está configurado, cargamos los datos del panel directamente
      if (res.isSetup) {
        loadDashboardData();
      }
    });
  }, []);

  const loadDashboardData = () => {
    invoke('getGlobalProjects').then((data) => {
      setProjectOptions([{ label: 'Todos los proyectos', value: 'all' }, ...data]);
      setIsLoadingProjects(false);
    });
    fetchKPIs(); 
  };

  const fetchKPIs = () => {
    setIsApplying(true);
    invoke('getKPIData', { projects: selectedProjects, timeGrouping: timeGrouping, cohort: selectedCohort })
      .then((data) => {
        setSummaryData(data.summary);
        setTableDataRaw(data.tableData);
        setIsApplying(false);
      });
  };

  const handleConnectBot = () => {
    if (!inputToken.trim()) return;
    setIsValidating(true);
    setSetupError(null);
    
    invoke('saveBotToken', { token: inputToken.trim() }).then((res) => {
      setIsValidating(false);
      if (res.success) {
        setIsConfigured(true);
        loadDashboardData();
      } else {
        setSetupError(res.error);
      }
    });
  };

  // ─────────────────────────────────────────────────────────
  // VISTA 1: ONBOARDING WIZARD (Asistente de configuración)
  // ─────────────────────────────────────────────────────────
  if (isLoadingSetup) {
    return <Text>Cargando panel...</Text>;
  }

  if (!isConfigured) {
    return (
      <Stack space="space.400">
        <Box xcss={xcss({ maxWidth: '600px', margin: 'auto', padding: 'space.400', backgroundColor: 'elevation.surface.raised', borderRadius: 'border.radius', boxShadow: 'elevation.shadow.raised' })}>
          <Stack space="space.300">
            <Heading size="large">Conecta tu Project Manager Bot 🤖</Heading>
            <Text>Bienvenido. Para que Telegram Sync pueda notificar y medir la eficiencia de tu equipo, primero necesitamos crear el bot que los asistirá.</Text>
            
            <Stack space="space.100">
              <Text weight="bold">Paso 1: Obtén tu Token de acceso</Text>
              <Text>Haz clic en el siguiente enlace para ir a Telegram (puedes usar web o teléfono). Presiona "Start" o escribe `/newbot` y sigue las instrucciones para ponerle un nombre a tu asistente.</Text>
              <Button appearance="subtle" iconAfter="shortcut" onClick={() => window.open('https://t.me/BotFather', '_blank')}>
                Ir a BotFather en Telegram
              </Button>
            </Stack>

            <Stack space="space.100">
              <Text weight="bold">Paso 2: Pega tu Token aquí</Text>
              <Text>Cuando BotFather te dé el texto rojo (Ej: 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11), pégalo abajo:</Text>
              <Textfield 
                placeholder="Ingresa el token HTTP API..." 
                value={inputToken}
                onChange={(e) => setInputToken(e.target.value)}
              />
            </Stack>

            {setupError && (
              <SectionMessage appearance="error">
                <Text>{setupError}</Text>
              </SectionMessage>
            )}

            <Button appearance="primary" onClick={handleConnectBot} isLoading={isValidating}>
              Conectar y Activar Panel
            </Button>
          </Stack>
        </Box>
      </Stack>
    );
  }

  // ─────────────────────────────────────────────────────────
  // VISTA 2: PANEL ESTRATÉGICO (Se muestra cuando isConfigured es true)
  // ─────────────────────────────────────────────────────────
  const tableHead = {
    cells: [
      { key: 'periodo', content: <Text weight="bold">Periodo</Text> },
      { key: 'interacciones', content: centerText('Interacciones Totales', true) },
      { key: 'estancadas', content: centerText('Tareas Estancadas (>2d)', true) },
      { key: 'eficiencia', content: centerText('Eficiencia Promedio (Días/SP)', true) }
    ],
  };

  const tableRows = tableDataRaw.map((row, index) => ({
    key: `row-${index}`,
    cells: [
      { key: `c1-${index}`, content: <Text>{row.period}</Text> },
      { key: `c2-${index}`, content: centerText(row.interacciones.toString()) },
      { key: `c3-${index}`, content: centerText(row.estancadas.toString()) },
      { key: `c4-${index}`, content: centerText(row.eficiencia.toString()) }
    ]
  }));

  return (
    <Stack space="space.400">
      <Heading size="large">Panel de Control Estratégico</Heading>

      <Inline space="space.200" alignBlock="end">
        <Box xcss={filterBoxStyle}>
          <Select
            isMulti
            appearance="default"
            name="proyectos"
            placeholder="Proyecto(s)"
            isLoading={isLoadingProjects}
            options={projectOptions}
            onChange={(opts) => setSelectedProjects(opts ? opts.map(o => o.value) : [])}
          />
        </Box>
        <Box xcss={filterBoxStyle}>
          <Select
            appearance="default"
            name="tiempo"
            placeholder="Agrupación Temporal"
            defaultValue={{ label: 'Por Semanas', value: 'semanas' }}
            options={[
              { label: 'Por Semanas', value: 'semanas' },
              { label: 'Por Meses', value: 'meses' }
            ]}
            onChange={(val) => setTimeGrouping(val?.value || 'semanas')}
          />
        </Box>
        <Box xcss={filterBoxStyle}>
          <Select
            appearance="default"
            name="cohort"
            placeholder="Grupo (Telegram)"
            defaultValue={{ label: 'Todos', value: 'all' }}
            options={[
              { label: 'Todos', value: 'all' },
              { label: 'Con Telegram (Piloto)', value: 'telegram' },
              { label: 'Sin Telegram (Control)', value: 'no-telegram' }
            ]}
            onChange={(val) => setSelectedCohort(val?.value || 'all')}
          />
        </Box>
        <Box>
          <Button appearance="primary" onClick={fetchKPIs} isLoading={isApplying}>
            Aplicar Filtros
          </Button>
        </Box>
      </Inline>

      <Inline space="space.300" alignBlock="stretch">
        <Box xcss={cardStyle}>
          <Text weight="bold">Interacciones Totales</Text>
          <Heading size="xlarge">{summaryData.interacciones}</Heading>
        </Box>
        <Box xcss={cardStyle}>
          <Text weight="bold">Tareas Estancadas (&gt;2d Sin Novedad)</Text>
          <Heading size="xlarge">{summaryData.estancadas}</Heading>
        </Box>
        <Box xcss={cardStyle}>
          <Text weight="bold">Eficiencia (Tiempo / Story Point)</Text>
          <Heading size="xlarge">{summaryData.eficiencia}</Heading>
        </Box>
      </Inline>

      <Box xcss={xcss({ marginTop: 'space.200', marginBottom: 'space.200' })}>
        <DynamicTable head={tableHead} rows={tableRows} />
      </Box>

    </Stack>
  );
};

ForgeReconciler.render(<App />);
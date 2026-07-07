import React, { useState } from 'react';
import ForgeReconciler, { Text, Button, Stack, SectionMessage, Link } from '@forge/react';
import { invoke } from '@forge/bridge'; // <-- ¡Devuelta a su librería correcta!

const ConfigPanel = () => {
  const [token, setToken] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleGenerateToken = async () => {
    setIsLoading(true);
    try {
      const newToken = await invoke('generateToken');
      setToken(newToken);
    } catch (error) {
      console.error("Error al generar el token:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Stack space="space.200">
      <Text>🔌 Sincronización con Telegram</Text>
      <Text>Vincula tu cuenta de Jira con Telegram para recibir notificaciones y actualizar el estado de tus tickets desde el chat.</Text>

      {!token ? (
        <Button appearance="primary" isLoading={isLoading} onClick={handleGenerateToken}>
          Generar Enlace de Sincronización
        </Button>
      ) : (
        <SectionMessage appearance="success" title="¡Token generado con éxito!">
          <Text>Tu token seguro es: {token}</Text>
          <Text>
            Haz clic en el siguiente enlace para abrir Telegram y presiona "Iniciar". Si el bot no responde, envíale este mensaje manualmente: /start {token}
          </Text>
          {/* IMPORTANTE: Cambia "TU_BOT_USERNAME_AQUI" por el nombre real de tu bot sin la @ */}
          <Link href={`https://t.me/JiraSeguimientoBot?start=${token}`} openNewTab={true}>
            👉 Abrir Telegram y Sincronizar
          </Link>
        </SectionMessage>
      )}
    </Stack>
  );
};

ForgeReconciler.render(<ConfigPanel />);
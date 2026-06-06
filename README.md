# Bot Libros al Mayoreo — WhatsApp Normal (QR)

## Cómo funciona

1. Abres el panel web → escaneas el QR con tu WhatsApp normal
2. Subes una nota/cotización PDF al grupo
3. El bot la lee con IA, detecta el teléfono y nombre del cliente
4. En el panel aparece la nota lista → tú eliges con qué cuenta mandarla
5. Das clic en "Enviar" → el bot manda el PDF + total + datos bancarios al cliente
6. Subes la guía al grupo → el bot la manda automáticamente al cliente sin pedir nada

## Instalar y correr local

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-xxx GROUP_NAME="Libros" node index.js
```
Abre http://localhost:3000 y escanea el QR.

## Deploy en Railway

1. Sube a GitHub (nuevo repositorio, sube todos los archivos)
2. railway.app → New Project → Deploy from GitHub
3. Variables: ANTHROPIC_API_KEY y GROUP_NAME
4. Railway te da URL pública → abre esa URL y escanea el QR

## Notas importantes

- El teléfono del cliente debe aparecer en la parte superior de la nota
  Formato: 521XXXXXXXXXX (con código de país, sin espacios)
- La sesión de WhatsApp se guarda en .wa-session/
  Si reinicias el servidor, NO tienes que volver a escanear el QR
- Las cuentas bancarias se guardan en cuentas.json (se crean desde el panel)

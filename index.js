const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const GEMINI_API_KEY  = process.env.GEMINI_API_KEY || "";
const GROUP_NAME      = process.env.GROUP_NAME || "";
const PHONE_NUMBER    = process.env.PHONE_NUMBER || "";
const PORT            = process.env.PORT || 3000;

const CUENTAS_FILE = path.join(__dirname, "cuentas.json");
function loadCuentas() {
  try { return JSON.parse(fs.readFileSync(CUENTAS_FILE, "utf8")); } catch { return []; }
}
function saveCuentas(c) { fs.writeFileSync(CUENTAS_FILE, JSON.stringify(c, null, 2)); }

const pendientes = {};
let groupId = null;
const logs = [];
let sock = null;
let waReady = false;
let pairingCode = null;
let pairingRequested = false;

function addLog(tipo, msg) {
  const entry = { tipo, msg, time: new Date().toLocaleTimeString("es-MX") };
  logs.unshift(entry);
  if (logs.length > 100) logs.pop();
  console.log(`[${tipo.toUpperCase()}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function analizarConGemini(b64, mimeType, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: b64 } },
        { text: prompt }
      ]
    }]
  };
  const resp = await axios.post(url, body, { headers: { "Content-Type": "application/json" } });
  return resp.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function connectWA() {
  const { state, saveCreds } = await useMultiFileAuthState(".wa-session");

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
    },
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    mobile: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (!pairingRequested && !sock.authState.creds.registered && PHONE_NUMBER) {
      pairingRequested = true;
      await sleep(10000);
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER.replace(/\D/g, ""));
        pairingCode = code;
        addLog("ok", `Código de vinculación: ${code} — ingrésalo en WhatsApp > Dispositivos vinculados > Vincular con número`);
      } catch (e) {
        addLog("error", "Error solicitando código: " + e.message);
      }
    }

    if (connection === "open") {
      waReady = true;
      pairingCode = null;
      addLog("ok", "WhatsApp conectado ✅");
    }

    if (connection === "close") {
      waReady = false;
      pairingRequested = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      addLog("error", `Desconectado — ${shouldReconnect ? "reconectando..." : "sesión cerrada"}`);
      if (shouldReconnect) { await sleep(5000); connectWA(); }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      if (!from.endsWith("@g.us")) continue;

      if (!groupId && GROUP_NAME) {
        try {
          const meta = await sock.groupMetadata(from);
          if (meta.subject.toLowerCase().includes(GROUP_NAME.toLowerCase())) {
            groupId = from;
            addLog("info", `Grupo detectado: "${meta.subject}"`);
          } else continue;
        } catch { continue; }
      }

      if (groupId && from !== groupId) continue;

      const hasDoc = !!msg.message?.documentMessage;
      const hasImg = !!msg.message?.imageMessage;
      if (!hasDoc && !hasImg) continue;

      addLog("info", "Archivo recibido — analizando con Gemini...");

      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {}, {
          logger: pino({ level: "silent" }),
          reuploadRequest: sock.updateMediaMessage
        });

        const mimeType = hasDoc
          ? msg.message.documentMessage.mimetype
          : msg.message.imageMessage.mimetype;

        const b64 = buffer.toString("base64");

        const prompt = `Analiza este documento. Responde SOLO con JSON sin markdown ni backticks:
{
  "tipo": "nota" si es cotización o nota de pedido, "guia" si es guía de envío, "otro" si no es ninguna,
  "telefono": "teléfono del cliente en la parte superior, formato 521XXXXXXXXXX sin espacios, vacío si no hay",
  "nombre": "nombre del cliente si aparece, vacío si no",
  "total": "monto total a pagar con símbolo si es nota, vacío si es guía",
  "desglose": "resumen breve del pedido si es nota",
  "numero_guia": "número de guía si es guía, vacío si no",
  "paqueteria": "nombre paquetería si es guía, vacío si no"
}`;

        const raw = await analizarConGemini(b64, mimeType, prompt);
        const clean = raw.replace(/```json|```/g, "").trim();
        let datos;
        try { datos = JSON.parse(clean); } catch { addLog("error", "Error parseando: " + raw); continue; }

        addLog("info", `Detectado: ${datos.tipo} | ${datos.nombre} | ${datos.telefono}`);

        if (datos.tipo === "otro") continue;
        if (!datos.telefono) { addLog("warn", "No se encontró teléfono"); continue; }

        const tel = datos.telefono.replace(/\D/g, "") + "@s.whatsapp.net";

        if (datos.tipo === "nota") {
          const id = "nota_" + Date.now();
          pendientes[id] = {
            id, tel, nombre: datos.nombre || "Cliente",
            total: datos.total || "—", desglose: datos.desglose || "",
            buffer, mimeType, timestamp: new Date().toISOString()
          };
          addLog("ok", `Nota de ${datos.nombre} lista — selecciona cuenta en el panel`);
        }

        if (datos.tipo === "guia") {
          await sock.sendMessage(tel, {
            document: buffer, mimetype: mimeType,
            fileName: "guia_envio.pdf", caption: "Tu guía de envío está lista 📦"
          });
          await sleep(60000);
          await sock.sendMessage(tel, {
            text: `📦 *¡Tu guía de envío!*\n\n${datos.paqueteria ? `🚚 Paquetería: ${datos.paqueteria}\n` : ""}${datos.numero_guia ? `🔢 Guía: ${datos.numero_guia}\n` : ""}\nYa puedes rastrear tu paquete.\n\n¡Gracias por tu compra! 🙏`
          });
          addLog("ok", `Guía enviada a ${datos.nombre || tel}`);
        }

      } catch (e) {
        addLog("error", "Error: " + e.message);
      }
    }
  });
}

async function enviarNota(pendienteId, cuentaId) {
  const p = pendientes[pendienteId];
  if (!p) throw new Error("Pendiente no encontrado");
  const cuentas = loadCuentas();
  const cuenta = cuentas.find(c => c.id === cuentaId);
  if (!cuenta) throw new Error("Cuenta no encontrada");

  await sock.sendMessage(p.tel, {
    document: p.buffer, mimetype: p.mimeType,
    fileName: "nota_pedido.pdf", caption: `Tu nota de pedido — ${p.nombre}`
  });
  await sleep(700);

  const mensaje =
`Hola ${p.nombre} 👋

Aquí está tu nota de pedido 📋
${p.desglose ? `\n${p.desglose}\n` : ""}
💰 *Total a pagar: ${p.total}*

━━━━━━━━━━━━━━━━━
🏦 *Datos para transferencia:*
- Banco: ${cuenta.banco}
- Titular: ${cuenta.titular}
- CLABE: ${cuenta.clabe}${cuenta.tarjeta ? `\n• Tarjeta: ${cuenta.tarjeta}` : ""}
- Concepto: ${p.nombre}
━━━━━━━━━━━━━━━━━

Una vez realizado el pago, envíame el *comprobante* y te mandamos tu guía 🚚🙏`;

  await sock.sendMessage(p.tel, { text: mensaje });
  delete pendientes[pendienteId];
  addLog("ok", `Nota enviada a ${p.nombre}`);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (_, res) => res.json({ waReady, pairingCode, groupId }));
app.get("/api/pendientes", (_, res) => res.json(Object.values(pendientes).map(p => ({
  id: p.id, tel: p.tel, nombre: p.nombre, total: p.total, desglose: p.desglose, timestamp: p.timestamp
}))));
app.get("/api/cuentas", (_, res) => res.json(loadCuentas()));
app.post("/api/cuentas", (req, res) => {
  const { banco, titular, clabe, tarjeta } = req.body;
  if (!banco || !titular || !clabe) return res.status(400).json({ error: "Faltan campos" });
  const cuentas = loadCuentas();
  const nueva = { id: "c" + Date.now(), banco, titular, clabe, tarjeta: tarjeta || "" };
  cuentas.push(nueva); saveCuentas(cuentas);
  res.json(nueva);
});
app.delete("/api/cuentas/:id", (req, res) => {
  let cuentas = loadCuentas();
  cuentas = cuentas.filter(c => c.id !== req.params.id);
  saveCuentas(cuentas); res.json({ ok: true });
});
app.post("/api/enviar", async (req, res) => {
  const { pendienteId, cuentaId } = req.body;
  try { await enviarNota(pendienteId, cuentaId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/logs", (_, res) => res.json(logs));

app.listen(PORT, () => {
  addLog("info", `Panel web en puerto ${PORT}`);
  connectWA();
});

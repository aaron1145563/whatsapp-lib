const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const express = require("express");
const qrcode = require("qrcode");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const http = require("http");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GROUP_NAME        = process.env.GROUP_NAME || "";
const PORT              = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const CUENTAS_FILE = path.join(__dirname, "cuentas.json");
function loadCuentas() {
  try { return JSON.parse(fs.readFileSync(CUENTAS_FILE, "utf8")); } catch { return []; }
}
function saveCuentas(c) { fs.writeFileSync(CUENTAS_FILE, JSON.stringify(c, null, 2)); }

const pendientes = {};
let groupId = null;
const logs = [];

function addLog(tipo, msg) {
  const entry = { tipo, msg, time: new Date().toLocaleTimeString("es-MX") };
  logs.unshift(entry);
  if (logs.length > 100) logs.pop();
  console.log(`[${tipo.toUpperCase()}] ${msg}`);
}

// ── WHATSAPP CLIENT ── con puppeteer configurado para Render ─────────────────
const waClient = new Client({
  authStrategy: new LocalAuth({ dataPath: ".wa-session" }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu"
    ]
  }
});

let qrDataUrl = null;
let waReady = false;

waClient.on("qr", async (qr) => {
  qrDataUrl = await qrcode.toDataURL(qr);
  waReady = false;
  addLog("info", "QR generado — escanea con tu WhatsApp");
});

waClient.on("ready", () => {
  waReady = true;
  qrDataUrl = null;
  addLog("ok", "WhatsApp conectado ✅");
});

waClient.on("disconnected", () => {
  waReady = false;
  addLog("error", "WhatsApp desconectado");
});

waClient.on("message", async (msg) => {
  try {
    const chat = await msg.getChat();

    if (chat.isGroup && !groupId) {
      if (!GROUP_NAME || chat.name.toLowerCase().includes(GROUP_NAME.toLowerCase())) {
        groupId = chat.id._serialized;
        addLog("info", `Grupo detectado: "${chat.name}" → ${groupId}`);
      }
    }

    if (!chat.isGroup) return;
    if (groupId && chat.id._serialized !== groupId) return;
    if (!msg.hasMedia) return;

    const tipo = msg.type;
    if (!["document", "image"].includes(tipo)) return;

    addLog("info", `Archivo recibido en grupo (${tipo}) — analizando con IA...`);

    const media = await msg.downloadMedia();
    if (!media) return;

    const b64 = media.data;
    const mimeType = media.mimetype;
    const isPDF = mimeType === "application/pdf";

    const contentBlock = isPDF
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
      : { type: "image", source: { type: "base64", media_type: mimeType || "image/jpeg", data: b64 } };

    const aiResp = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: [
          contentBlock,
          {
            type: "text",
            text: `Analiza este documento. Responde SOLO con JSON sin markdown:
{
  "tipo": "nota" si es cotización/nota de pedido, "guia" si es guía de envío, "otro" si no es ninguna,
  "telefono": "teléfono del cliente en la parte superior, formato 521XXXXXXXXXX sin espacios, vacío si no hay",
  "nombre": "nombre del cliente si aparece, vacío si no",
  "total": "monto total a pagar con símbolo si es nota, vacío si es guía",
  "desglose": "resumen breve del pedido si es nota",
  "numero_guia": "número de guía si es guía, vacío si no",
  "paqueteria": "nombre paquetería si es guía, vacío si no"
}`
          }
        ]
      }]
    });

    const raw = aiResp.content.map(c => c.text || "").join("").replace(/```json|```/g, "").trim();
    let datos;
    try { datos = JSON.parse(raw); } catch { addLog("error", "IA no pudo parsear: " + raw); return; }

    addLog("info", `IA detectó: tipo=${datos.tipo} | cliente=${datos.nombre} | tel=${datos.telefono}`);

    if (datos.tipo === "otro") return;
    if (!datos.telefono) { addLog("warn", "No se encontró teléfono en el documento"); return; }

    const tel = datos.telefono.replace(/\D/g, "");

    if (datos.tipo === "nota") {
      const id = "nota_" + Date.now();
      pendientes[id] = {
        id, tel, nombre: datos.nombre || "Cliente",
        total: datos.total || "—", desglose: datos.desglose || "",
        media, mimeType, timestamp: new Date().toISOString()
      };
      addLog("ok", `Nota de ${datos.nombre} (${tel}) lista — selecciona cuenta en el panel`);
    }

    if (datos.tipo === "guia") {
      const contactId = `${tel}@c.us`;
      await waClient.sendMessage(contactId, media, { caption: "Tu guía de envío está lista 📦" });
      await sleep(600);
      await waClient.sendMessage(contactId,
`📦 *¡Tu guía de envío!*\n\n${datos.paqueteria ? `🚚 Paquetería: ${datos.paqueteria}\n` : ""}${datos.numero_guia ? `🔢 Guía: ${datos.numero_guia}\n` : ""}\nYa puedes rastrear tu paquete.\n\n¡Gracias por tu compra! 🙏`
      );
      addLog("ok", `Guía enviada a ${datos.nombre || tel}`);
    }

  } catch (e) {
    addLog("error", "Error procesando mensaje: " + e.message);
  }
});

async function enviarNota(pendienteId, cuentaId) {
  const p = pendientes[pendienteId];
  if (!p) throw new Error("Pendiente no encontrado");
  const cuentas = loadCuentas();
  const cuenta = cuentas.find(c => c.id === cuentaId);
  if (!cuenta) throw new Error("Cuenta no encontrada");

  const contactId = `${p.tel}@c.us`;
  await waClient.sendMessage(contactId, p.media, { caption: `Tu nota de pedido — ${p.nombre}` });
  await sleep(700);

  const mensaje =
`Hola ${p.nombre} 👋\n\nAquí está tu nota de pedido 📋\n${p.desglose ? `\n${p.desglose}\n` : ""}\n💰 *Total a pagar: ${p.total}*\n\n━━━━━━━━━━━━━━━━━\n🏦 *Datos para transferencia:*\n• Banco: ${cuenta.banco}\n• Titular: ${cuenta.titular}\n• CLABE: ${cuenta.clabe}${cuenta.tarjeta ? `\n• Tarjeta: ${cuenta.tarjeta}` : ""}\n• Concepto: ${p.nombre}\n━━━━━━━━━━━━━━━━━\n\nUna vez realizado el pago, envíame el *comprobante* y te mandamos tu guía 🚚🙏`;

  await waClient.sendMessage(contactId, mensaje);
  delete pendientes[pendienteId];
  addLog("ok", `Nota + datos de ${cuenta.banco} enviados a ${p.nombre} (${p.tel})`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── EXPRESS ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (_, res) => res.json({ waReady, qrDataUrl, groupId, GROUP_NAME }));
app.get("/api/pendientes", (_, res) => res.json(Object.values(pendientes)));
app.get("/api/cuentas", (_, res) => res.json(loadCuentas()));
app.post("/api/cuentas", (req, res) => {
  const { banco, titular, clabe, tarjeta } = req.body;
  if (!banco || !titular || !clabe) return res.status(400).json({ error: "Faltan campos" });
  const cuentas = loadCuentas();
  const nueva = { id: "c" + Date.now(), banco, titular, clabe, tarjeta: tarjeta || "" };
  cuentas.push(nueva);
  saveCuentas(cuentas);
  res.json(nueva);
});
app.delete("/api/cuentas/:id", (req, res) => {
  let cuentas = loadCuentas();
  cuentas = cuentas.filter(c => c.id !== req.params.id);
  saveCuentas(cuentas);
  res.json({ ok: true });
});
app.post("/api/enviar", async (req, res) => {
  const { pendienteId, cuentaId } = req.body;
  try { await enviarNota(pendienteId, cuentaId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/logs", (_, res) => res.json(logs));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

http.createServer(app).listen(PORT, () => {
  addLog("info", `Panel web en http://localhost:${PORT}`);
  waClient.initialize();
});

const { default: makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock = null;
let conectado = false;
let conectando = false;
let qrCodeData = ''; // Variable global para guardar el string del QR

async function connectToWhatsApp() {
    if (conectando) return;
    conectando = true;
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        sock = makeWASocket({
            auth: state,
            browser: Browsers.macOS('Desktop'),
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
            if (qr) {
                qrCodeData = qr; // Guardamos la cadena del QR para el navegador
                console.log('\n[QR Generado] Escanee en los logs o visite /qr en su navegador');
                qrcodeTerminal.generate(qr, { small: true });
            }
            if (connection === 'open') {
                conectado = true;
                conectando = false;
                qrCodeData = ''; // Limpiamos el QR una vez conectado
                console.log('WhatsApp conectado con éxito.');
            }
            if (connection === 'close') {
                conectado = false;
                conectando = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const cerrarSesion = statusCode === DisconnectReason.loggedOut;
                if (cerrarSesion) {
                    console.log('Sesión cerrada. Elimine la carpeta auth_info.');
                } else {
                    console.log('Conexión perdida. Reintentando en 3 segundos...');
                    setTimeout(connectToWhatsApp, 3000);
                }
            }
        });
    } catch (error) {
        conectado = false;
        conectando = false;
        console.error('Error conectando WhatsApp:', error.message);
        setTimeout(connectToWhatsApp, 5000);
    }
}

// --- RUTAS DE LA API ---

// 1. Ruta de bienvenida
app.get('/', (req, res) => {
    res.send('<h1>API WhatsApp - Colegio Activa</h1><p>Visite <a href="/qr">/qr</a> para vincular o <a href="/health">/health</a> para el estado.</p>');
});

// 2. Ruta para escanear el QR desde una página web limpia
app.get('/qr', async (req, res) => {
    if (conectado) {
        return res.send('<h2 style="color:green;font-family:sans-serif;text-align:center;margin-top:50px;">✅ WhatsApp ya está CONECTADO. No necesita escanear QR.</h2>');
    }
    if (!qrCodeData) {
        return res.send('<h2 style="color:orange;font-family:sans-serif;text-align:center;margin-top:50px;">⏳ Generando código QR... Recargue esta página en 5 segundos.</h2>');
    }
    try {
        const qrImage = await QRCode.toDataURL(qrCodeData);
        res.send(`
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;">
                <h2 style="margin-bottom:10px;">Escanea este QR con WhatsApp</h2>
                <p style="color:#666;margin-top:0;">Abre WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
                <img src="${qrImage}" alt="QR Code" style="width:320px;height:320px;border:2px solid #ccc;padding:10px;border-radius:10px;"/>
            </div>
        `);
    } catch (err) {
        res.status(500).send('Error al generar la imagen del QR.');
    }
});

// 3. Estado de la conexión
app.get('/health', (req, res) => {
    res.json({ status: 'ok', whatsapp: conectado ? 'connected' : 'disconnected' });
});

// 4. Endpoint para enviar mensajes
app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;
    if (!number || !message) {
        return res.status(400).json({ status: 'error', message: 'Faltan parámetros.' });
    }
    if (!sock || !conectado) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp no está conectado.' });
    }

    const limpio = String(number).replace(/[^0-9]/g, '');
    const jid = limpio + '@s.whatsapp.net';
    try {
        await sock.sendMessage(jid, { text: String(message) });
        res.json({ status: 'success', message: 'Mensaje enviado correctamente.' });
    } catch (error) {
        console.error('Error enviando mensaje:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor listo en el puerto ${PORT}`);
    connectToWhatsApp();
});
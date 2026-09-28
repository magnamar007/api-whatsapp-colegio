const { default: makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock = null;
let conectado = false;
let conectando = false;

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
                console.log('\nEscanee este QR con WhatsApp para vincular el equipo:');
                qrcode.generate(qr, { small: true });
            }
            if (connection === 'open') {
                conectado = true;
                conectando = false;
                console.log('WhatsApp conectado.');
            }
            if (connection === 'close') {
                conectado = false;
                conectando = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const cerrarSesion = statusCode === DisconnectReason.loggedOut;
                if (cerrarSesion) {
                    console.log('La sesión fue cerrada. Elimine auth_info y vuelva a escanear el QR.');
                } else {
                    console.log('Conexión cerrada. Reintentando en 3 segundos...');
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

app.get('/health', (req, res) => {
    res.json({ status: 'ok', whatsapp: conectado ? 'connected' : 'disconnected' });
});

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
        res.json({ status: 'success', message: 'Mensaje enviado.' });
    } catch (error) {
        console.error('Error enviando mensaje:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.listen(3000, '127.0.0.1', () => {
    console.log('API local de WhatsApp lista en http://127.0.0.1:3000');
    connectToWhatsApp();
});

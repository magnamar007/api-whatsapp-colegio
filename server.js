const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock = null;
let conectado = false;
let conectando = false;
let qrCodeData = '';


// ============================================
// CONECTAR WHATSAPP
// ============================================

async function connectToWhatsApp() {

    if (conectando) {
        console.log('Ya existe un intento de conexión.');
        return;
    }

    conectando = true;

    try {

        console.log('Iniciando conexión con WhatsApp...');

        const { state, saveCreds } =
            await useMultiFileAuthState('auth_info');

        sock = makeWASocket({
            auth: state,
            browser: Browsers.macOS('Desktop'),
            syncFullHistory: false,
            markOnlineOnConnect: false
        });


        // Guardar credenciales
        sock.ev.on('creds.update', saveCreds);


        // ============================================
        // EVENTOS DE CONEXIÓN
        // ============================================

        sock.ev.on(
            'connection.update',
            ({ connection, qr, lastDisconnect }) => {

                // NUEVO QR
                if (qr) {

                    qrCodeData = qr;

                    console.log('');
                    console.log('================================');
                    console.log('NUEVO QR GENERADO');
                    console.log('================================');
                    console.log('Visite /qr para escanearlo.');

                    qrcodeTerminal.generate(
                        qr,
                        { small: true }
                    );
                }


                // CONEXIÓN ABIERTA
                if (connection === 'open') {

                    conectado = true;
                    conectando = false;
                    qrCodeData = '';

                    console.log('');
                    console.log('================================');
                    console.log('WHATSAPP CONECTADO');
                    console.log('================================');
                }


                // CONEXIÓN CERRADA
                if (connection === 'close') {

                    conectado = false;
                    conectando = false;

                    const statusCode =
                        lastDisconnect
                            ?.error
                            ?.output
                            ?.statusCode;

                    console.log(
                        'Conexión cerrada. Código:',
                        statusCode
                    );

                    const cerrarSesion =
                        statusCode ===
                        DisconnectReason.loggedOut;


                    if (cerrarSesion) {

                        qrCodeData = '';

                        console.log(
                            'La sesión fue cerrada.'
                        );

                        console.log(
                            'Se necesita una nueva vinculación.'
                        );

                    } else {

                        console.log(
                            'Reconectando en 3 segundos...'
                        );

                        setTimeout(
                            connectToWhatsApp,
                            3000
                        );
                    }
                }
            }
        );


    } catch (error) {

        conectado = false;
        conectando = false;

        console.error(
            'ERROR DE WHATSAPP:',
            error
        );

        setTimeout(
            connectToWhatsApp,
            5000
        );
    }
}


// ============================================
// PÁGINA PRINCIPAL
// ============================================

app.get('/', (req, res) => {

    res.send(`
        <!DOCTYPE html>

        <html lang="es">

        <head>
            <meta charset="UTF-8">

            <title>
                API WhatsApp Colegio
            </title>
        </head>

        <body style="
            font-family:Arial;
            text-align:center;
            padding:50px;
        ">

            <h1>
                API WhatsApp - Colegio Petrolera II
            </h1>

            <p>
                Estado del servidor: funcionando
            </p>

            <p>
                <a href="/qr">
                    Vincular WhatsApp
                </a>
            </p>

            <p>
                <a href="/health">
                    Ver estado
                </a>
            </p>

        </body>

        </html>
    `);
});


// ============================================
// MOSTRAR QR
// ============================================

app.get('/qr', async (req, res) => {

    // YA ESTÁ CONECTADO
    if (conectado) {

        return res.send(`
            <!DOCTYPE html>

            <html lang="es">

            <head>
                <meta charset="UTF-8">

                <title>
                    WhatsApp conectado
                </title>
            </head>

            <body style="
                font-family:Arial;
                text-align:center;
                padding-top:100px;
            ">

                <h1 style="color:green;">
                    WhatsApp conectado
                </h1>

                <p>
                    El dispositivo ya está vinculado.
                </p>

                <a href="/health">
                    Consultar estado
                </a>

            </body>

            </html>
        `);
    }


    // TODAVÍA NO EXISTE QR
    if (!qrCodeData) {

        return res.send(`
            <!DOCTYPE html>

            <html lang="es">

            <head>

                <meta charset="UTF-8">

                <meta
                    http-equiv="refresh"
                    content="3"
                >

                <title>
                    Generando QR
                </title>

            </head>

            <body style="
                font-family:Arial;
                text-align:center;
                padding-top:100px;
            ">

                <h2>
                    Generando código QR...
                </h2>

                <p>
                    Espere unos segundos.
                </p>

                <p>
                    La página se actualizará
                    automáticamente.
                </p>

            </body>

            </html>
        `);
    }


    // GENERAR IMAGEN
    try {

        const qrImage =
            await QRCode.toDataURL(
                qrCodeData,
                {
                    width: 450,
                    margin: 4,
                    errorCorrectionLevel: 'M'
                }
            );


        res.send(`
            <!DOCTYPE html>

            <html lang="es">

            <head>

                <meta charset="UTF-8">

                <meta
                    http-equiv="refresh"
                    content="15"
                >

                <title>
                    Vincular WhatsApp
                </title>

            </head>


            <body style="
                margin:0;
                background:#f0f2f5;
                font-family:Arial;
            ">


                <div style="
                    display:flex;
                    flex-direction:column;
                    justify-content:center;
                    align-items:center;
                    min-height:100vh;
                ">


                    <div style="
                        background:white;
                        padding:30px;
                        border-radius:15px;
                        text-align:center;
                        box-shadow:0 4px 20px
                        rgba(0,0,0,.15);
                    ">

                        <h2>
                            Vincular WhatsApp
                        </h2>


                        <p>
                            WhatsApp →
                            Dispositivos vinculados →
                            Vincular dispositivo
                        </p>


                        <img
                            src="${qrImage}"
                            alt="QR WhatsApp"
                            style="
                                width:450px;
                                height:450px;
                            "
                        >


                        <p style="color:#777;">
                            Escanee este código
                            desde su teléfono.
                        </p>

                    </div>

                </div>

            </body>

            </html>
        `);


    } catch (error) {

        console.error(
            'Error generando QR:',
            error
        );

        res
            .status(500)
            .send(
                'Error generando el código QR.'
            );
    }
});


// ============================================
// HEALTH
// ============================================

app.get('/health', (req, res) => {

    res.json({

        status: 'ok',

        whatsapp:
            conectado
                ? 'connected'
                : 'disconnected',

        qr:
            qrCodeData
                ? 'available'
                : 'not_available'
    });
});


// ============================================
// ENVIAR MENSAJES
// ============================================

app.post('/send-message', async (req, res) => {

    const {
        number,
        message
    } = req.body;


    if (!number || !message) {

        return res
            .status(400)
            .json({

                status: 'error',

                message:
                    'Faltan los parámetros number o message.'
            });
    }


    if (!sock || !conectado) {

        return res
            .status(503)
            .json({

                status: 'error',

                message:
                    'WhatsApp no está conectado.'
            });
    }


    const limpio =
        String(number)
            .replace(/[^0-9]/g, '');


    const jid =
        limpio + '@s.whatsapp.net';


    try {

        await sock.sendMessage(
            jid,
            {
                text: String(message)
            }
        );


        console.log(
            'Mensaje enviado a:',
            limpio
        );


        res.json({

            status: 'success',

            message:
                'Mensaje enviado correctamente.'
        });


    } catch (error) {

        console.error(
            'Error enviando mensaje:',
            error
        );


        res
            .status(500)
            .json({

                status: 'error',

                message:
                    error.message
            });
    }
});


// ============================================
// INICIAR SERVIDOR
// ============================================

const PORT =
    process.env.PORT || 3000;


app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `Servidor iniciado en puerto ${PORT}`
        );

        connectToWhatsApp();
    }
);
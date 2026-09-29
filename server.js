const {
    default: makeWASocket,
    Browsers,
    DisconnectReason,
    initAuthCreds,
    BufferJSON,
    proto
} = require('@whiskeysockets/baileys');

const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ======================================================
// CONFIGURACIÓN SUPABASE
// ======================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error(
        'ERROR: Faltan SUPABASE_URL o SUPABASE_SECRET_KEY.'
    );
    process.exit(1);
}

const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false
        }
    }
);

// ======================================================
// ESTADO GENERAL
// ======================================================

let sock = null;
let conectado = false;
let conectando = false;
let qrCodeData = '';
let cambiandoNumero = false;
let reconnectTimer = null;

// Permite identificar sockets antiguos.
// Evita que una conexión anterior provoque nuevas reconexiones
// después de que otro socket ya haya tomado su lugar.
let socketGeneration = 0;

// IDs utilizados en Supabase.
const CREDS_ID = 'baileys:creds';
const KEY_PREFIX = 'baileys:key:';

// ======================================================
// SERIALIZACIÓN BAILEYS
// ======================================================

function serializar(valor) {
    const texto = JSON.stringify(
        valor,
        BufferJSON.replacer
    );

    return JSON.parse(texto);
}

function deserializar(valor) {
    if (valor === null || valor === undefined) {
        return null;
    }

    return JSON.parse(
        JSON.stringify(valor),
        BufferJSON.reviver
    );
}

// ======================================================
// SUPABASE - LEER REGISTRO
// ======================================================

async function leerRegistro(id) {
    const { data, error } = await supabase
        .from('whatsapp_session')
        .select('data')
        .eq('id', id)
        .maybeSingle();

    if (error) {
        throw new Error(
            `Error leyendo ${id}: ${error.message}`
        );
    }

    if (!data) {
        return null;
    }

    return deserializar(data.data);
}

// ======================================================
// SUPABASE - GUARDAR REGISTRO
// ======================================================

async function guardarRegistro(id, valor) {
    const { error } = await supabase
        .from('whatsapp_session')
        .upsert(
            {
                id,
                data: serializar(valor),
                updated_at: new Date().toISOString()
            },
            {
                onConflict: 'id'
            }
        );

    if (error) {
        throw new Error(
            `Error guardando ${id}: ${error.message}`
        );
    }
}

// ======================================================
// SUPABASE - ELIMINAR REGISTRO
// ======================================================

async function eliminarRegistro(id) {
    const { error } = await supabase
        .from('whatsapp_session')
        .delete()
        .eq('id', id);

    if (error) {
        throw new Error(
            `Error eliminando ${id}: ${error.message}`
        );
    }
}

// ======================================================
// CREAR AUTH STATE DIRECTAMENTE EN SUPABASE
// ======================================================

async function useSupabaseAuthState() {
    let creds = await leerRegistro(CREDS_ID);

    if (!creds) {
        console.log(
            'No existe sesión persistente. Creando credenciales nuevas.'
        );

        creds = initAuthCreds();

        await guardarRegistro(
            CREDS_ID,
            creds
        );
    } else {
        console.log(
            'Credenciales de WhatsApp recuperadas desde Supabase.'
        );
    }

    const keys = {
        get: async (type, ids) => {
            const resultado = {};

            await Promise.all(
                ids.map(async (id) => {
                    const registroId =
                        `${KEY_PREFIX}${type}:${id}`;

                    let valor =
                        await leerRegistro(registroId);

                    if (
                        type === 'app-state-sync-key' &&
                        valor
                    ) {
                        valor =
                            proto.Message
                                .AppStateSyncKeyData
                                .fromObject(valor);
                    }

                    if (valor !== null) {
                        resultado[id] = valor;
                    }
                })
            );

            return resultado;
        },

        set: async (data) => {
            const operaciones = [];

            for (
                const categoria of Object.keys(data)
            ) {
                const valores = data[categoria];

                for (
                    const id of Object.keys(valores)
                ) {
                    const valor = valores[id];

                    const registroId =
                        `${KEY_PREFIX}${categoria}:${id}`;

                    if (
                        valor === null ||
                        valor === undefined
                    ) {
                        operaciones.push(
                            eliminarRegistro(registroId)
                        );
                    } else {
                        operaciones.push(
                            guardarRegistro(
                                registroId,
                                valor
                            )
                        );
                    }
                }
            }

            await Promise.all(operaciones);
        }
    };

    const saveCreds = async () => {
        await guardarRegistro(
            CREDS_ID,
            creds
        );
    };

    return {
        state: {
            creds,
            keys
        },
        saveCreds
    };
}

// ======================================================
// LIMPIAR SESIÓN DE SUPABASE
// ======================================================

async function limpiarSesionSupabase() {
    console.log(
        'Eliminando sesión persistente de WhatsApp...'
    );

    const { error } = await supabase
        .from('whatsapp_session')
        .delete()
        .or(
            `id.eq.${CREDS_ID},id.like.${KEY_PREFIX}%`
        );

    if (error) {
        throw new Error(
            'No se pudo limpiar la sesión: ' +
            error.message
        );
    }

    console.log(
        'Sesión de WhatsApp eliminada de Supabase.'
    );
}

// ======================================================
// PROGRAMAR RECONEXIÓN
// ======================================================

function programarReconexion(ms = 3000) {
    if (cambiandoNumero) {
        return;
    }

    if (reconnectTimer) {
        return;
    }

    console.log(
        `Reconectando en ${ms / 1000} segundos...`
    );

    reconnectTimer = setTimeout(
        async () => {
            reconnectTimer = null;

            try {
                await connectToWhatsApp();
            } catch (error) {
                console.error(
                    'Error durante reconexión:',
                    error.message
                );
            }
        },
        ms
    );
}

// ======================================================
// CONECTAR WHATSAPP
// ======================================================

async function connectToWhatsApp() {

    // ==================================================
    // EVITAR CONEXIONES DUPLICADAS
    // ==================================================

    if (conectando) {
        console.log(
            'Ya existe un intento de conexión.'
        );

        return;
    }


    if (sock && conectado) {

        console.log(
            'WhatsApp ya está conectado. ' +
            'No se creará otro socket.'
        );

        return;
    }


    conectando = true;


    /*
     * Cada nueva conexión obtiene un número.
     *
     * Si posteriormente se crea otro socket,
     * los eventos pertenecientes al anterior
     * serán ignorados.
     */
    const myGeneration = ++socketGeneration;


    try {

        console.log(
            'Iniciando conexión con WhatsApp...'
        );


        // ==============================================
        // RECUPERAR CREDENCIALES DE SUPABASE
        // ==============================================

        const {
            state,
            saveCreds

        } = await useSupabaseAuthState();


        /*
         * Es posible que mientras esperábamos la respuesta
         * de Supabase se haya iniciado otra conexión.
         *
         * En ese caso abandonamos este intento.
         */
        if (
            myGeneration !== socketGeneration
        ) {

            conectando = false;

            console.log(
                'Intento de conexión antiguo cancelado.'
            );

            return;
        }


        // ==============================================
        // CREAR SOCKET DE WHATSAPP
        // ==============================================

        const currentSock = makeWASocket({

            auth: state,


            browser:
                Browsers.macOS(
                    'Desktop'
                ),


            syncFullHistory: false,


            markOnlineOnConnect: false

        });


        /*
         * Guardamos este socket como
         * la conexión actualmente válida.
         */
        sock = currentSock;


        // ==============================================
        // GUARDAR CREDENCIALES
        // ==============================================

        currentSock.ev.on(

            'creds.update',

            async () => {


                /*
                 * Si estas credenciales pertenecen
                 * a un socket anterior, no las guardamos.
                 *
                 * Esto evita que un socket viejo sobrescriba
                 * en Supabase las credenciales de uno nuevo.
                 */
                if (
                    myGeneration !== socketGeneration ||
                    sock !== currentSock
                ) {

                    return;
                }


                try {

                    await saveCreds();


                    console.log(
                        'Credenciales actualizadas en Supabase.'
                    );


                } catch (error) {

                    console.error(
                        'Error guardando credenciales:',
                        error.message
                    );

                }

            }

        );


        // ==============================================
        // EVENTOS DE CONEXIÓN
        // ==============================================

        currentSock.ev.on(

            'connection.update',

            ({

                connection,

                qr,

                lastDisconnect

            }) => {


                /*
                 * MUY IMPORTANTE:
                 *
                 * Ignoramos cualquier evento perteneciente
                 * a un socket que ya haya sido reemplazado.
                 */
                if (
                    myGeneration !== socketGeneration ||
                    sock !== currentSock
                ) {

                    console.log(
                        'Evento ignorado de un socket anterior.'
                    );

                    return;
                }


                // ======================================
                // NUEVO QR
                // ======================================

                if (qr) {

                    qrCodeData = qr;


                    console.log('');

                    console.log(
                        '================================'
                    );

                    console.log(
                        'NUEVO QR GENERADO'
                    );

                    console.log(
                        '================================'
                    );

                    console.log(
                        'Visite /qr para escanearlo.'
                    );


                    qrcodeTerminal.generate(

                        qr,

                        {
                            small: true
                        }

                    );

                }


                // ======================================
                // WHATSAPP CONECTADO
                // ======================================

                if (
                    connection === 'open'
                ) {

                    conectado = true;

                    conectando = false;

                    cambiandoNumero = false;

                    qrCodeData = '';


                    /*
                     * Si existía una reconexión pendiente
                     * ya no es necesaria.
                     */
                    if (reconnectTimer) {

                        clearTimeout(
                            reconnectTimer
                        );

                        reconnectTimer = null;

                    }


                    console.log('');

                    console.log(
                        '================================'
                    );

                    console.log(
                        'WHATSAPP CONECTADO'
                    );

                    console.log(
                        '================================'
                    );

                }


                // ======================================
                // CONEXIÓN CERRADA
                // ======================================

                if (
                    connection === 'close'
                ) {

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


                    // ==================================
                    // LOGOUT REAL DE WHATSAPP
                    // ==================================

                    const loggedOut =

                        statusCode ===
                        DisconnectReason.loggedOut;


                    // ==================================
                    // CAMBIO DE NÚMERO
                    // ==================================

                    if (
                        cambiandoNumero
                    ) {

                        console.log(
                            'Cambio de número en proceso.'
                        );

                        return;
                    }


                    // ==================================
                    // SESIÓN INVALIDADA
                    // ==================================

                    if (
                        loggedOut
                    ) {

                        qrCodeData = '';


                        console.log(
                            'WhatsApp cerró la sesión.'
                        );


                        console.log(
                            'Debe vincular nuevamente ' +
                            'el dispositivo.'
                        );


                        return;
                    }


                    // ==================================
                    // ERROR 440
                    // CONFLICT / REPLACED
                    // ==================================

                    if (
                        statusCode === 440
                    ) {

                        console.log(

                            'Conflicto 440/replaced detectado. ' +
                            'Esperando 15 segundos antes de reconectar...'

                        );


                        /*
                         * Quitamos el socket que recibió
                         * el conflicto.
                         */
                        if (
                            sock === currentSock
                        ) {

                            sock = null;

                        }


                        /*
                         * Invalida inmediatamente todos
                         * los eventos posteriores que puedan
                         * provenir del socket anterior.
                         */
                        socketGeneration++;


                        /*
                         * Eliminamos cualquier reconexión
                         * que estuviera pendiente.
                         */
                        if (
                            reconnectTimer
                        ) {

                            clearTimeout(
                                reconnectTimer
                            );

                        }


                        /*
                         * Render puede mantener durante unos
                         * segundos la instancia anterior.
                         *
                         * Por eso esperamos 15 segundos.
                         */
                        reconnectTimer =
                            setTimeout(

                                async () => {

                                    reconnectTimer = null;


                                    /*
                                     * Si mientras esperábamos
                                     * WhatsApp volvió a conectarse,
                                     * no hacemos nada.
                                     */
                                    if (
                                        cambiandoNumero ||
                                        conectado
                                    ) {

                                        return;
                                    }


                                    try {

                                        await connectToWhatsApp();


                                    } catch (error) {

                                        console.error(

                                            'Error después del conflicto 440:',

                                            error.message

                                        );


                                        programarReconexion(
                                            10000
                                        );

                                    }

                                },

                                15000

                            );


                        return;

                    }


                    // ==================================
                    // OTRAS DESCONEXIONES
                    // ==================================

                    /*
                     * El socket cerrado deja de ser válido.
                     */
                    if (
                        sock === currentSock
                    ) {

                        sock = null;

                    }


                    /*
                     * Invalidamos cualquier evento posterior
                     * perteneciente a este socket.
                     */
                    socketGeneration++;


                    /*
                     * Para errores normales esperamos
                     * 5 segundos.
                     */
                    programarReconexion(
                        5000
                    );

                }

            }

        );


    } catch (error) {


        /*
         * Solo modificamos el estado global
         * si este sigue siendo el intento actual.
         */
        if (
            myGeneration === socketGeneration
        ) {

            conectado = false;

            conectando = false;

            sock = null;


            socketGeneration++;

        }


        console.error(

            'ERROR DE WHATSAPP:',

            error

        );


        /*
         * Si hubo un error creando el socket
         * esperamos un poco más antes de intentar.
         */
        programarReconexion(
            10000
        );

    }

}

// ======================================================
// PÁGINA PRINCIPAL
// ======================================================

app.get('/', (req, res) => {
    const estado =
        conectado
            ? '🟢 WhatsApp conectado'
            : '🔴 WhatsApp desconectado';

    res.send(`
        <!DOCTYPE html>

        <html lang="es">

        <head>
            <meta charset="UTF-8">

            <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
            >

            <title>
                API WhatsApp Colegio
            </title>
        </head>

        <body style="
            margin:0;
            background:#f0f2f5;
            font-family:Arial,sans-serif;
        ">

            <div style="
                max-width:600px;
                margin:70px auto;
                background:white;
                padding:35px;
                border-radius:15px;
                box-shadow:0 4px 20px rgba(0,0,0,.12);
                text-align:center;
            ">

                <h1>
                    API WhatsApp
                </h1>

                <h2>
                    Colegio Petrolera II
                </h2>

                <p style="
                    font-size:20px;
                    margin:30px 0;
                ">
                    ${estado}
                </p>

                <p>
                    <a href="/qr">
                        Vincular / Ver WhatsApp
                    </a>
                </p>

                <p>
                    <a href="/health">
                        Consultar estado
                    </a>
                </p>

                ${
                    conectado
                        ? `
                            <hr style="margin:30px 0;">

                            <h3>
                                Cambiar número de WhatsApp
                            </h3>

                            <p>
                                Esta opción cerrará la sesión actual
                                y permitirá vincular otro número.
                            </p>

                            <form
                                method="POST"
                                action="/logout"
                                onsubmit="
                                    return confirm(
                                        '¿Está seguro de cambiar el número de WhatsApp?'
                                    );
                                "
                            >
                                <button
                                    type="submit"
                                    style="
                                        background:#c62828;
                                        color:white;
                                        border:none;
                                        border-radius:8px;
                                        padding:12px 20px;
                                        cursor:pointer;
                                    "
                                >
                                    Cambiar número
                                </button>
                            </form>
                        `
                        : ''
                }

            </div>

        </body>

        </html>
    `);
});

// ======================================================
// MOSTRAR QR
// ======================================================

app.get('/qr', async (req, res) => {
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

                <p>
                    <a href="/">
                        Volver al inicio
                    </a>
                </p>

            </body>

            </html>
        `);
    }

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
                        box-shadow:0 4px 20px rgba(0,0,0,.15);
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
                                width:100%;
                                max-width:450px;
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

// ======================================================
// HEALTH
// ======================================================

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

// ======================================================
// ENVIAR MENSAJES
// ======================================================

app.post(
    '/send-message',
    async (req, res) => {
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
                .replace(
                    /[^0-9]/g,
                    ''
                );

        if (!limpio) {
            return res
                .status(400)
                .json({
                    status: 'error',
                    message:
                        'El número de teléfono no es válido.'
                });
        }

        const jid =
            limpio +
            '@s.whatsapp.net';

        try {
            await sock.sendMessage(
                jid,
                {
                    text:
                        String(message)
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
    }
);

// ======================================================
// CERRAR SESIÓN / CAMBIAR NÚMERO
// ======================================================

app.post(
    '/logout',
    async (req, res) => {
        if (cambiandoNumero) {
            return res
                .status(409)
                .send(
                    'Ya existe un cambio de número en proceso.'
                );
        }

        cambiandoNumero = true;

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        conectado = false;
        conectando = false;
        qrCodeData = '';

        try {
            console.log(
                'Iniciando cambio de número...'
            );

            const socketAnterior = sock;

            /*
            * Invalidamos inmediatamente los eventos
            * pertenecientes al socket anterior.
            */
            socketGeneration++;

            sock = null;

            /*
             * logout() informa a WhatsApp que este
             * dispositivo vinculado debe cerrarse.
             */
            if (socketAnterior) {
                try {
                    await socketAnterior.logout();
                } catch (errorLogout) {
                    console.log(
                        'Aviso durante logout:',
                        errorLogout.message
                    );
                }
            }

            await limpiarSesionSupabase();

            console.log(
                'Sesión anterior eliminada.'
            );

            /*
             * Permitimos nuevamente la conexión.
             */
            cambiandoNumero = false;

            setTimeout(
                () => {
                    connectToWhatsApp()
                        .catch((error) => {
                            console.error(
                                'Error generando nueva sesión:',
                                error.message
                            );
                        });
                },
                1500
            );

            return res.send(`
                <!DOCTYPE html>

                <html lang="es">

                <head>
                    <meta charset="UTF-8">

                    <meta
                        http-equiv="refresh"
                        content="3;url=/qr"
                    >

                    <title>
                        Cambiar WhatsApp
                    </title>
                </head>

                <body style="
                    font-family:Arial;
                    text-align:center;
                    padding-top:100px;
                ">

                    <h2>
                        Sesión anterior eliminada
                    </h2>

                    <p>
                        Estamos generando un nuevo
                        código QR.
                    </p>

                    <p>
                        Será redirigido automáticamente.
                    </p>

                    <p>
                        <a href="/qr">
                            Ir al nuevo QR
                        </a>
                    </p>

                </body>

                </html>
            `);

        } catch (error) {
            cambiandoNumero = false;

            console.error(
                'Error cambiando número:',
                error
            );

            programarReconexion(3000);

            return res
                .status(500)
                .send(
                    'No fue posible cambiar el número: ' +
                    error.message
                );
        }
    }
);

// ======================================================
// INICIAR SERVIDOR
// ======================================================

const PORT =
    process.env.PORT || 3000;

app.listen(
    PORT,
    '0.0.0.0',
    () => {
        console.log(
            `Servidor iniciado en puerto ${PORT}`
        );

        connectToWhatsApp()
            .catch((error) => {
                console.error(
                    'Error iniciando WhatsApp:',
                    error
                );
            });
    }
);
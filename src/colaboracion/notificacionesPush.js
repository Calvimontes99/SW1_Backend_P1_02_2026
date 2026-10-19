/**
 * Notificaciones push con Firebase Cloud Messaging (gratis), para los integrantes que NO están
 * conectados a la sala: mensajes del equipo, respuestas y propuestas de la IA, y cambios del
 * diagrama agrupados (RF-12). Usa la API HTTP v1 de FCM firmando el token con la cuenta de
 * servicio, sin dependencias extra.
 *
 * Se activa con FIREBASE_SERVICE_ACCOUNT: el JSON de la cuenta de servicio de Firebase (tal cual o
 * en base64). Sin esa variable no hace nada.
 */
import { createSign } from 'node:crypto';
import { integrantesDeSala, leerMemoria, quitarDispositivo, tokensDeUsuarios } from './repositorio.js';

const AGRUPAR_CAMBIOS_MS = Number(process.env.PUSH_AGRUPAR_CAMBIOS_MS || 5 * 60 * 1000);

let cuenta;
const cuentaDeServicio = () => {
    if (cuenta !== undefined) return cuenta;
    const crudo = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
    if (!crudo) { cuenta = null; return cuenta; }
    try {
        cuenta = JSON.parse(crudo.startsWith('{') ? crudo : Buffer.from(crudo, 'base64').toString('utf8'));
    } catch {
        console.error('FIREBASE_SERVICE_ACCOUNT no es un JSON válido: las notificaciones push quedan apagadas');
        cuenta = null;
    }
    return cuenta;
};

export const pushDisponible = () => !!cuentaDeServicio();

let accesoCache = { token: null, vence: 0 };
const base64url = (x) => Buffer.from(x).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const tokenDeAcceso = async () => {
    if (accesoCache.token && Date.now() < accesoCache.vence - 60000) return accesoCache.token;
    const c = cuentaDeServicio();
    const ahora = Math.floor(Date.now() / 1000);
    const cabecera = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const cuerpo = base64url(JSON.stringify({
        iss: c.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: c.token_uri || 'https://oauth2.googleapis.com/token', iat: ahora, exp: ahora + 3600,
    }));
    const firma = createSign('RSA-SHA256').update(`${cabecera}.${cuerpo}`).sign(c.private_key);
    const r = await fetch(c.token_uri || 'https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cabecera}.${cuerpo}.${base64url(firma)}` }),
    });
    if (!r.ok) throw new Error(`Firebase rechazó la cuenta de servicio (${r.status})`);
    const d = await r.json();
    accesoCache = { token: d.access_token, vence: Date.now() + (d.expires_in || 3600) * 1000 };
    return accesoCache.token;
};

const enviarA = async (tokens, titulo, texto, datos) => {
    const c = cuentaDeServicio();
    const acceso = await tokenDeAcceso();
    await Promise.all(tokens.map(async ({ token }) => {
        const r = await fetch(`https://fcm.googleapis.com/v1/projects/${c.project_id}/messages:send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${acceso}` },
            body: JSON.stringify({
                message: {
                    token,
                    notification: { title: titulo, body: texto.length > 180 ? `${texto.slice(0, 177)}…` : texto },
                    data: Object.fromEntries(Object.entries(datos || {}).map(([k, v]) => [k, String(v)])),
                    android: { priority: 'high', notification: { channel_id: 'novedades_sala' } },
                },
            }),
        });
        // El teléfono desinstaló la app o renovó el token: se olvida
        if (r.status === 404 || r.status === 400) await quitarDispositivo(token).catch(() => {});
    }));
};

/** Quiénes están conectados a cada sala ahora (lo fija el servidor de sockets). */
let conectadosDe = () => new Set();
export const configurarPush = ({ conectadosIds }) => { conectadosDe = conectadosIds; };

/**
 * Avisa a los integrantes de la sala que no la tienen abierta.
 * @param {{excepto?: number}} opciones  excepto: el autor (no se avisa a sí mismo)
 */
export const avisarIntegrantes = async (salaId, encabezado, texto, { excepto = null } = {}) => {
    if (!pushDisponible()) return;
    try {
        const { titulo: tituloSala } = await leerMemoria(salaId);
        const titulo = encabezado ? `${tituloSala}: ${encabezado}` : tituloSala;
        const conectados = conectadosDe(salaId);
        const destino = (await integrantesDeSala(salaId))
            .map((u) => u.id)
            .filter((id) => id !== excepto && !conectados.has(id));
        const tokens = await tokensDeUsuarios(destino);
        if (tokens.length) await enviarA(tokens, titulo, texto, { salaId, titulo: tituloSala });
    } catch (error) {
        console.warn('Push: no se pudo avisar:', error.message);
    }
};

/** Cambios del diagrama: un solo aviso cada pocos minutos por sala ("Ana y la IA hicieron 7 cambios"). */
const pendientesCambios = new Map();
export const avisarCambio = (salaId, cambio) => {
    if (!pushDisponible()) return;
    const p = pendientesCambios.get(salaId) || { autores: new Set(), cantidad: 0, reloj: null };
    p.autores.add(cambio.esIA ? 'la IA' : cambio.autorNombre || 'alguien');
    p.cantidad += 1;
    if (!p.reloj) {
        p.reloj = setTimeout(() => {
            pendientesCambios.delete(salaId);
            const autores = [...p.autores];
            const quien = autores.length > 1 ? `${autores.slice(0, -1).join(', ')} y ${autores.at(-1)}` : autores[0];
            const verbo = autores.length > 1 ? 'hicieron' : 'hizo';
            avisarIntegrantes(salaId, null, `${quien} ${verbo} ${p.cantidad} cambio${p.cantidad === 1 ? '' : 's'} en el diagrama`);
        }, AGRUPAR_CAMBIOS_MS);
    }
    pendientesCambios.set(salaId, p);
};

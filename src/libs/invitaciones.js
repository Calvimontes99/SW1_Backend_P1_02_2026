/**
 * Invitaciones a una sala por enlace o QR. Antes, cualquier usuario con sesión que conociera el
 * número de la sala quedaba inscrito al abrirla; ahora hace falta una invitación firmada por el
 * servidor, que solo genera el dueño. Se firma con una clave derivada de la de sesión, así una
 * invitación nunca sirve como token de sesión (ni al revés).
 */
import jwt from 'jsonwebtoken';
import { TOKEN_SECRET } from '../config.js';

const CLAVE = `${TOKEN_SECRET}:invitacion-sala`;
const VIGENCIA = process.env.INVITACION_VIGENCIA || '7d';

export const crearInvitacion = (salaId, creadorId) => jwt.sign(
    { tipo: 'invitacion', salaId: Number(salaId), creador: Number(creadorId) },
    CLAVE,
    { expiresIn: VIGENCIA },
);

/** true si el token es una invitación vigente para esa sala. */
export const invitacionValida = (token, salaId) => {
    if (!token || typeof token !== 'string' || token.length > 2000) return false;
    try {
        const datos = jwt.verify(token, CLAVE);
        return datos?.tipo === 'invitacion' && Number(datos.salaId) === Number(salaId);
    } catch {
        return false;
    }
};

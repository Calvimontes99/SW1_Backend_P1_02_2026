/**
 * API de la colaboración para la app móvil (y cualquier cliente sin socket): chat de la sala,
 * historial de cambios, propuestas de la IA y registro del dispositivo para notificaciones.
 */
import { Router } from 'express';
import { authRequired } from '../middlewares/validateToken.js';
import { puedeAccederASala } from '../libs/salaAccess.js';
import { decidirPropuesta, estadoIA } from '../colaboracion/iaSala.js';
import {
    listarCambios, listarMensajes, listarPropuestas, nombreDeUsuario, quitarDispositivo, registrarDispositivo, salasDeUsuario,
} from '../colaboracion/repositorio.js';
import { publicarMensaje, resumenDesdeVisita } from '../colaboracion/socketsColaboracion.js';
import { crearInvitacion } from '../libs/invitaciones.js';
import { transcribirAudio } from '../libs/transcribir.js';
import multer from 'multer';

// Foto o audio adjunto al chat (solo en memoria: viaja a la IA y no se guarda)
const adjunto = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = (file.fieldname === 'imagen' && file.mimetype.startsWith('image/'))
            || (file.fieldname === 'audio' && file.mimetype.startsWith('audio/'));
        cb(ok ? null : new Error('Solo se aceptan imágenes o audios.'), ok);
    },
}).fields([{ name: 'imagen', maxCount: 1 }, { name: 'audio', maxCount: 1 }]);
const conAdjunto = (req, res, next) => adjunto(req, res, (err) => {
    if (!err) return next();
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        error: true, message: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo es demasiado grande: el máximo es 10 MB.' : err.message,
    });
});

const router = Router();

const conAcceso = async (req, res, next) => {
    try {
        const salaId = parseInt(req.params.salaId, 10);
        if (isNaN(salaId)) return res.status(400).json({ error: true, message: 'La dirección del tablero no es válida.' });
        const acceso = await puedeAccederASala(req.user?.id, salaId);
        if (!acceso.ok) return res.status(acceso.status).json({ error: true, message: acceso.message });
        const datos = await nombreDeUsuario(req.user.id);
        req.salaId = salaId;
        req.autor = { id: req.user.id, nombre: datos?.nombre || datos?.email || 'Alguien' };
        return next();
    } catch (error) {
        return next(error);
    }
};

const enviar = (res, data) => res.json({ error: false, data });

// Mis salas (propias e invitadas), de la más activa a la menos
router.get('/salas', authRequired, async (req, res, next) => {
    try {
        enviar(res, await salasDeUsuario(req.user.id));
    } catch (error) { next(error); }
});

router.get('/:salaId/mensajes', authRequired, conAcceso, async (req, res, next) => {
    try {
        const antesDe = req.query.antesDe ? parseInt(req.query.antesDe, 10) : null;
        const canal = req.query.canal || null; // equipo | ia (sin canal: los dos chats)
        enviar(res, { mensajes: await listarMensajes(req.salaId, { limite: req.query.limite, antesDe, canal }), ia: estadoIA(req.salaId) });
    } catch (error) { next(error); }
});

// Mensaje al chat (también desde el móvil). Con formulario se puede adjuntar una foto o un audio:
// el audio se transcribe y el texto queda en el chat; la foto va a la IA junto con el pedido.
router.post('/:salaId/mensajes', authRequired, conAcceso, conAdjunto, async (req, res, next) => {
    try {
        const paraIA = req.body?.paraIA === true || req.body?.paraIA === 'true';
        const imagenArchivo = req.files?.imagen?.[0];
        const audioArchivo = req.files?.audio?.[0];
        let texto = req.body?.texto;
        if (audioArchivo) {
            const transcripcion = await transcribirAudio(audioArchivo.buffer, audioArchivo.mimetype);
            texto = `${texto ? `${texto} ` : ''}${transcripcion}`;
        }
        const imagen = imagenArchivo ? { buffer: imagenArchivo.buffer, tipo: imagenArchivo.mimetype, nombre: imagenArchivo.originalname } : null;
        const mensaje = await publicarMensaje(req.app.get('io'), req.salaId, req.autor, texto, paraIA, {
            imagen, ajusta: req.body?.ajusta, deAudio: !!audioArchivo,
        });
        res.status(201).json({ error: false, data: mensaje });
    } catch (error) {
        if (error.message === 'El mensaje está vacío.' || /audio|transcrib|micrófono/i.test(error.message)) {
            return res.status(400).json({ error: true, message: error.message });
        }
        return next(error);
    }
});

router.get('/:salaId/cambios', authRequired, conAcceso, async (req, res, next) => {
    try {
        enviar(res, await listarCambios(req.salaId, { limite: req.query.limite, autor: req.query.autor || null }));
    } catch (error) { next(error); }
});

router.get('/:salaId/propuestas', authRequired, conAcceso, async (req, res, next) => {
    try {
        enviar(res, await listarPropuestas(req.salaId, { soloPendientes: req.query.pendientes === '1' }));
    } catch (error) { next(error); }
});

router.post('/:salaId/propuestas/:propuestaId', authRequired, conAcceso, async (req, res, next) => {
    try {
        const decision = req.body?.decision;
        if (!['aceptar', 'rechazar'].includes(decision)) return res.status(400).json({ error: true, message: 'Decisión no válida.' });
        const r = await decidirPropuesta(req.salaId, parseInt(req.params.propuestaId, 10), decision, req.autor);
        if (!r.ok) return res.status(409).json({ error: true, message: r.mensaje });
        return enviar(res, r.propuesta);
    } catch (error) { return next(error); }
});

// Enlace de invitación firmado (para el enlace y el QR): solo lo genera el dueño
router.get('/:salaId/invitacion', authRequired, conAcceso, async (req, res, next) => {
    try {
        const { sala } = await puedeAccederASala(req.user.id, req.salaId);
        const dueno = sala.userId || sala.userid || sala.user_id;
        if (parseInt(dueno, 10) !== parseInt(req.user.id, 10)) {
            return res.status(403).json({ error: true, message: 'Solo el creador del tablero puede invitar.' });
        }
        return enviar(res, { token: crearInvitacion(req.salaId, req.user.id) });
    } catch (error) { return next(error); }
});

router.get('/:salaId/novedades', authRequired, conAcceso, async (req, res, next) => {
    try {
        enviar(res, await resumenDesdeVisita(req.salaId, req.autor));
    } catch (error) { next(error); }
});

// Notificaciones push: la app registra el token de Firebase de este teléfono
router.post('/dispositivos', authRequired, async (req, res, next) => {
    try {
        const token = String(req.body?.token || '').trim();
        if (!token || token.length > 4096) return res.status(400).json({ error: true, message: 'Falta el token del dispositivo.' });
        await registrarDispositivo(req.user.id, token, String(req.body?.plataforma || 'android').slice(0, 20));
        res.status(201).json({ error: false, data: { registrado: true } });
    } catch (error) { next(error); }
});

router.delete('/dispositivos', authRequired, async (req, res, next) => {
    try {
        const token = String(req.body?.token || '').trim();
        if (token) await quitarDispositivo(token);
        enviar(res, { quitado: true });
    } catch (error) { next(error); }
});

export default router;

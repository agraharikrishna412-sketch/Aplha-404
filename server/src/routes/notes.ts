/** Notes API — CRUD, uploads (image/PDF/text), AI clean-up and note Q&A. */
import path from 'node:path';
import fs from 'node:fs/promises';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncRoute, HttpError, parseBody } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { limits } from '../middleware/rateLimit.js';
import { config } from '../config/env.js';
import { uuid } from '../db/index.js';
import {
  askAboutNote,
  classifyUpload,
  createNote,
  deleteNote,
  explainUpload,
  getNote,
  hasVisionKey,
  listNoteSubjects,
  listNotes,
  registerUpload,
  structureIntoNote,
  updateNote,
  type UploadedFile,
} from '../services/notes.js';

export const notesRouter = Router();
notesRouter.use(requireAuth);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(config.uploadDir);
      require('node:fs').mkdirSync(dir, { recursive: true, mode: 0o700 });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10) || '.bin';
      cb(null, `${uuid()}${ext}`);
    },
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: config.maxUploadFiles },
  fileFilter: (_req, file, cb) => {
    const kind = classifyUpload(file);
    if (!kind) {
      cb(new HttpError(415, 'Only images (PNG, JPG, WebP), PDFs and text files can be uploaded.'));
      return;
    }
    cb(null, true);
  },
});

function toUploadedFiles(files: Express.Multer.File[]): UploadedFile[] {
  return files.map((file) => ({
    path: file.path,
    originalName: file.originalname,
    mime: file.mimetype,
    size: file.size,
    kind: classifyUpload(file) ?? 'text',
  }));
}

notesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const query = parseBody(
      z.object({
        search: z.string().max(120).optional(),
        subject: z.string().max(60).optional(),
        starred: z.enum(['true', 'false']).optional(),
      }),
      req.query,
    );
    const [notes, subjects, visionKey] = await Promise.all([
      listNotes(req.user!.id, {
        search: query.search,
        subject: query.subject,
        starredOnly: query.starred === 'true',
      }),
      listNoteSubjects(req.user!.id),
      hasVisionKey(req.user!.id),
    ]);
    res.json({ notes, subjects, canReadImages: visionKey });
  }),
);

notesRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        title: z.string().trim().min(1, 'Give your note a title.').max(160),
        content: z.string().max(200_000),
        subject: z.string().trim().max(60).optional(),
        chapter: z.string().trim().max(80).optional(),
        tags: z.array(z.string().max(30)).max(12).optional(),
      }),
      req.body,
    );
    res.status(201).json({ note: await createNote(req.user!.id, { ...body, source: 'manual' }) });
  }),
);

notesRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const note = await getNote(req.user!.id, req.params.id);
    if (!note) throw new HttpError(404, 'That note was not found.');
    res.json({ note });
  }),
);

notesRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        title: z.string().trim().min(1).max(160).optional(),
        content: z.string().max(200_000).optional(),
        subject: z.string().trim().max(60).nullable().optional(),
        chapter: z.string().trim().max(80).nullable().optional(),
        tags: z.array(z.string().max(30)).max(12).optional(),
        starred: z.boolean().optional(),
      }),
      req.body,
    );
    const note = await updateNote(req.user!.id, req.params.id, body);
    if (!note) throw new HttpError(404, 'That note was not found.');
    res.json({ note });
  }),
);

notesRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    await deleteNote(req.user!.id, req.params.id);
    res.json({ ok: true });
  }),
);

/** Upload → (vision/text) → structured note. Also supports pasting raw text. */
notesRouter.post(
  '/structure',
  limits.upload(),
  upload.array('files', config.maxUploadFiles),
  asyncRoute(async (req, res) => {
    const files = toUploadedFiles((req.files as Express.Multer.File[]) ?? []);
    const body = parseBody(
      z.object({
        text: z.string().max(60_000).optional(),
        title: z.string().trim().max(160).optional(),
        subject: z.string().trim().max(60).optional(),
        chapter: z.string().trim().max(80).optional(),
      }),
      req.body,
    );

    if (!files.length && !body.text?.trim()) {
      throw new HttpError(400, 'Add a photo, a PDF or paste some text first.');
    }

    try {
      const result = await structureIntoNote({
        userId: req.user!.id,
        files,
        text: body.text,
        title: body.title,
        subject: body.subject,
        chapter: body.chapter,
      });
      for (const file of files) await registerUpload(req.user!.id, file, result.note.id);
      res.status(201).json({
        note: result.note,
        structured: result.structured,
        degraded: result.degraded,
        provider: result.provider,
        model: result.model,
        demo: result.demo,
      });
    } catch (err) {
      // Keep the upload on disk so the student can retry without re-uploading.
      for (const file of files) await registerUpload(req.user!.id, file);
      throw err;
    }
  }),
);

/** "Explain this photo" without creating a note. */
notesRouter.post(
  '/explain-upload',
  limits.upload(),
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const file = (req.files as Express.Multer.File[])?.[0] ?? (req.file as Express.Multer.File | undefined);
    if (!file) throw new HttpError(400, 'Attach an image or PDF to explain.');
    const body = parseBody(z.object({ question: z.string().max(500).optional() }), req.body);
    const [uploaded] = toUploadedFiles([file]);
    const result = await explainUpload({ userId: req.user!.id, file: uploaded, question: body.question });
    res.json(result);
  }),
);

const modeEnum = z.enum(['summary', 'keypoints', 'definitions', 'questions', 'explain']);

notesRouter.post(
  '/:id/ask',
  limits.ai(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ mode: modeEnum }), req.body);
    const result = await askAboutNote({ userId: req.user!.id, noteId: req.params.id, mode: body.mode });
    res.json(result);
  }),
);

/** Disk usage guard for the upload folder (surfaced in AI Settings). */
notesRouter.get(
  '/storage/info',
  asyncRoute(async (_req, res) => {
    let bytes = 0;
    try {
      const files = await fs.readdir(config.uploadDir);
      for (const file of files) {
        const stat = await fs.stat(path.join(config.uploadDir, file)).catch(() => null);
        bytes += stat?.size ?? 0;
      }
    } catch {
      bytes = 0;
    }
    res.json({ bytes, maxUploadMb: config.maxUploadMb });
  }),
);

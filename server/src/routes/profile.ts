/**
 * Student profile API (`/api/profile`).
 *
 * Two audiences share this router:
 *  - the owner, editing their own card (name, handle, bio, interests, avatar, privacy);
 *  - anyone else, reading a card they are allowed to see.
 *
 * Which fields come back is decided in `services/profile.ts`, never here, so the privacy rules are in
 * one place. Avatars are the only uploads here and they reuse the same storage rules as every other
 * upload in the app (size cap, image-only, random file name, never served as HTML).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncRoute, HttpError, parseBody } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { limits } from '../middleware/rateLimit.js';
import { config } from '../config/env.js';
import { uuid } from '../db/index.js';
import { registerUpload } from '../services/notes.js';
import { avatarPathFor, profileFor, searchPeople, setAvatar, updateProfile } from '../services/profile.js';

export const profileRouter = Router();
profileRouter.use(requireAuth);

const AVATAR_BYTES = 2 * 1024 * 1024;

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(config.uploadDir, 'avatars');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safe = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? ext : '.jpg';
      cb(null, `${uuid()}${safe}`);
    },
  }),
  limits: { fileSize: AVATAR_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Images only: an avatar is rendered on other students' screens, so nothing else is accepted.
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) {
      cb(new HttpError(415, 'An avatar must be a PNG, JPEG or WebP image.', 'unsupported_media_type'));
      return;
    }
    cb(null, true);
  },
});

profileRouter.get(
  '/me',
  asyncRoute(async (req, res) => {
    res.json(await profileFor(req.user!.id, req.user!.id));
  }),
);

profileRouter.get(
  '/people',
  asyncRoute(async (req, res) => {
    const term = String(req.query.q ?? '');
    res.json({ people: await searchPeople(req.user!.id, term) });
  }),
);

/**
 * Serves an avatar.
 *
 * Any signed-in student may read an avatar by id — that is what an avatar is for — but the file name
 * is re-derived from the database row rather than taken from the URL, so a crafted path cannot read
 * an arbitrary file. `nosniff` and a restrictive CSP mean an image can never execute.
 */
profileRouter.get(
  '/avatar/:userId/:file',
  asyncRoute(async (req, res) => {
    const found = await avatarPathFor(req.params.userId);
    if (!found || !fs.existsSync(found.path)) throw new HttpError(404, 'That avatar was not found.', 'not_found');
    res.setHeader('Content-Type', found.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(found.path);
  }),
);

profileRouter.get(
  '/:userId',
  asyncRoute(async (req, res) => {
    res.json(await profileFor(req.user!.id, req.params.userId));
  }),
);

profileRouter.patch(
  '/me',
  limits.general(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().min(2).max(80).optional(),
        username: z.string().max(40).nullable().optional(),
        bio: z.string().max(600).optional(),
        interests: z.array(z.string().max(40)).max(12).optional(),
        accent: z.string().max(20).nullable().optional(),
        classLevel: z.string().max(40).nullable().optional(),
        board: z.string().max(40).nullable().optional(),
        /*
         * Three choices, not two. 'members' means "students I share a community with"; the client has
         * offered it since the profile screen was rebuilt, and the server rejecting it produced a
         * stream of "Could not save that — Invalid enum value" toasts on a screen that looked fine.
         */
        profileVisibility: z.enum(['public', 'members', 'private']).optional(),
        dmPolicy: z.enum(['everyone', 'communities', 'nobody']).optional(),
        activityVisible: z.boolean().optional(),
        communitiesVisible: z.boolean().optional(),
        achievementsVisible: z.boolean().optional(),
      }),
      req.body ?? {},
    );
    res.json(await updateProfile(req.user!.id, body));
  }),
);

profileRouter.post(
  '/me/avatar',
  limits.upload(),
  (req, res, next) => {
    avatarUpload.single('avatar')(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(413, 'Avatars must be under 2 MB.', 'file_too_large'));
      }
      return next(err);
    });
  },
  asyncRoute(async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'Choose an image to use as your avatar.', 'validation_error');
    const stored = path.basename(file.path);
    await registerUpload(req.user!.id, {
      path: file.path,
      originalName: file.originalname,
      mime: file.mimetype,
      size: file.size,
      kind: 'image',
    });
    res.json(await setAvatar(req.user!.id, `/api/profile/avatar/${req.user!.id}/${stored}`));
  }),
);

profileRouter.delete(
  '/me/avatar',
  asyncRoute(async (req, res) => {
    res.json(await setAvatar(req.user!.id, null));
  }),
);


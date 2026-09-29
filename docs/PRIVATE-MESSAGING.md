# Private messaging — architecture, encryption and policies

This document describes what Vroqn Nexus actually does with a private message. It is written to be
checkable against the code, because the product is only allowed to claim what is true (master prompt
§7, §32.10).

- Server: `server/src/services/dm.ts`, `server/src/routes/messages.ts`
- Client: `client/src/features/messages/*`, `client/src/lib/crypto.ts`
- Storage: `dm_conversations`, `dm_members`, `dm_device_keys`, `dm_key_envelopes`, `dm_messages`,
  `dm_receipts`, `dm_reactions`, `dm_reports` (migrations `0009_profile_and_dm`, `0010_dm_safety`)
- Proof: `scripts/private-chat-check.mjs` (real browser, 18 checks), `server/test/private-chat.test.ts`
  (13 tests), deep scan section “Private messages” in `scripts/scan-site.mjs`

---

## 1. What is encrypted, and where the keys live

| Step | Where it happens | What the server sees |
| --- | --- | --- |
| Device identity | Browser, once per browser profile | Public ECDH **P-256** JWK only (`kty`, `crv`, `x`, `y`) |
| Private half of the device key | Browser, IndexedDB (`vroqn-private`) | Nothing — created `extractable: false`, never transmitted |
| Conversation key | Browser, on conversation creation | Nothing — a random **AES-256-GCM** key |
| Message | Browser, before `POST` | `ciphertext`, `iv`, `alg: 'AES-256-GCM'`, `key_version` |
| Conversation key delivery | Browser ⇄ browser | A wrapped blob per device: ECDH → HKDF-SHA256(`vroqn-dm-v1`, device id as salt) → AES-GCM |

The server never receives the conversation key, the device private key, or any plaintext of a message
body. `server/src/services/dm.ts` has no column, log line, or analytics path for message text: the
only fields written are ciphertext, its IV, the algorithm tag and the key version.

**Metadata the server necessarily holds** (stated plainly, because “E2E encrypted” does not mean
“invisible”): who is in a conversation, who sent each message, when, message size, reactions, edit and
delete timestamps, read watermarks, and the wrapped key envelopes.

## 2. What is *not* claimed

- **Not “verified” E2E.** There is no safety-number comparison between two students yet, so nothing
  stops a determined server operator from substituting a key. The UI does not say “verified”.
- **No protection against a compromised device.** If malware runs in the student’s browser it can read
  what the browser can read.
- **No key rotation on membership change.** `dm_conversations.key_version` exists and is carried
  through envelopes so rotation is possible, but removed participants are not re-keyed today (see
  Limitations in the acceptance report).

## 3. Policies (server-side, always)

`community_profile_settings.dm_policy` — settable by each student, enforced on the server:

| Value | Meaning |
| --- | --- |
| `everyone` | Any student can start a conversation |
| `communities` (default) | Only students who share an active community with you |
| `nobody` | Nobody can start a **new** conversation |

`nobody` deliberately does **not** break threads that already exist — the on-screen wording promises
“existing conversations continue”, so `open`/`send`/`list`/`detail` pass
`{ existingConversation: true }` and are unaffected by the policy. A student can still always delete a
conversation from their own list.

Blocks are unconditional and platform-wide:

- The blocked student cannot message, or start a conversation with, the blocker — refused with the
  neutral message *“You cannot message this student right now.”*
- The blocker sees an actionable message mentioning the block, so they know why the thread is quiet.
- Blocking applies to community chat and community membership too: `community_blocks` is the single
  block list, so a second private list cannot become a bypass (§8).

Search (`GET /api/profile/people?q=`) returns each candidate with `canMessage` and a readable `reason`,
so the UI never offers a conversation that the server would refuse. A student never appears in their
own search results.

## 4. Reporting and staff access

- `POST /api/messages/reports` records a report privately in `dm_reports` (`conversation_id`,
  `message_id`, `target_user_id`, reason, note). Reporting yourself is rejected.
- The staff queue (`GET /api/messages/reports`) is refused to students (403) — only holders of the platform
  staff role can read it. Staff see **metadata only**: who reported whom, about which message, and
  why. They cannot read the message body, because the server does not have it.
- Consequences for the reported party are applied by the community/platform moderation paths that
  already enforce roles; nothing here can be used to escalate a role.

## 5. Notifications

The DM notification carries the sender’s name and the conversation id, never message text. A preview
is impossible by construction (the server holds ciphertext), which is exactly what §28 asks for: a
preview must not leak content, and the safest preview is none.

## 6. Private content never reaches AI, analytics or search

- **AI:** no DM field is passed to any provider. The tutor, Code Lab, practice and analysis prompts are
  built from the student’s own study material — see `server/src/services/ai/prompts.ts`. There is no
  code path from `dm_messages` into a provider call.
- **Analytics:** `dm_*` tables appear in no aggregation query. The activity analytics read practice,
  exam and arena attempts only.
- **Search:** people search reads `community_profile_settings` (name, username, visibility), never
  message content. Community search reads community metadata and posts, never DMs.

## 7. Transport and session

- Session is a `JWT` in an `httpOnly` cookie; no token in `localStorage`, so a script injected into the
  page cannot read the session.
- Every DM route resolves the caller with `requireAuth` and checks membership of the specific
  conversation before reading or writing; there is no “list everything” endpoint.
- Writes are rate-limited (`limits.ai()` / write limiter) and payload-bounded (message length, batch
  size, history size), so a single client cannot flood a conversation or the server.
- Real-time delivery reuses the existing server-sent-events bus (`services/communities/bus.ts`,
  `dm_message`, `dm_message_updated`, `dm_message_deleted`, `dm_conversation`, `dm_read`). No
  WebSocket server, no Redis, no second service — the brief rules out new infrastructure (§6).

## 8. Data model (abridged)

```
dm_conversations (id, created_by, key_version, last_message_at, created_at, updated_at)
dm_members       (conversation_id, user_id, is_muted, is_archived, request_state, joined_at)
dm_device_keys   (user_id, device_id, public_key, alg='ECDH-P256', label, last_seen_at)
dm_key_envelopes (conversation_id, device_id, key_version, epk, iv, wrapped_key)
dm_messages      (conversation_id, sender_id, ciphertext, iv, alg, key_version,
                  reply_to_id, edited_at, deleted_at, created_at)
dm_receipts      (conversation_id, user_id, last_read_at)
dm_reactions     (message_id, user_id, reaction)
dm_reports       (reporter_id, conversation_id, message_id, target_user_id, reason, note, status)
```

Editing and deleting rewrite the ciphertext and set `edited_at` / `deleted_at`; the server still only
ever holds ciphertext. Unread counts come from `dm_receipts` watermarks, so the badge never requires
reading message bodies.

## 9. How to verify it yourself

```bash
# server: policy, block, reaction, report semantics (13 tests)
cd server && node --import tsx --test test/private-chat.test.ts

# browser: two students, real WebCrypto, ciphertext on the wire (18 checks)
npm run seed:arena --workspace server
node scripts/private-chat-check.mjs      # needs PLAYWRIGHT_BROWSERS_PATH if the browser is not in a standard place

# whole-site deep scan, including the messages screen
node scripts/scan-site.mjs
```

`scripts/private-chat-check.mjs` is the proof that matters: it drives two real browser contexts, sends
a message, and asserts that what reaches the API is ciphertext that the second context can decrypt
while the stored row cannot be read as text.

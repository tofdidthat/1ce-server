# R2 storage migration for beats and stems

## Goal

Move beat audio files and stems ZIP archives from PostgreSQL `BYTEA` tables to Cloudflare R2, while preserving access control and compatibility with existing beats.

PostgreSQL remains the source of truth for ownership, metadata, permissions and object references. R2 stores the binary assets.

## Current state

- `account_beat_audio` stores audio in 1 MiB `BYTEA` chunks.
- `account_beat_stems` stores stems ZIP archives in 1 MiB `BYTEA` chunks.
- `account_beats` stores owner, title, hashes, sizes and stems metadata.
- The existing R2 integration handles temporary uploads and cover images, but not permanent beat assets.

## Storage layout

Use the existing `R2_UPLOADS_BUCKET` with permanent object keys:

```text
beats/<userId>/<beatId>/audio/<objectId>
beats/<userId>/<beatId>/stems/<objectId>
```

The backend derives `userId` from the authenticated session and generates object IDs server-side. The browser must never choose the user ID or object key.

## Migration stages

1. Apply `database/r2-beat-storage.sql`.
2. Add R2 write support for newly uploaded beats and stems.
3. Update audio and stems read paths to use R2 when `audio_storage` or `stems_storage` is `r2`.
4. Keep PostgreSQL reads as a fallback for existing beats.
5. Run a dry-run migration that inventories rows without modifying them.
6. Copy existing PostgreSQL chunks to R2 in batches.
7. Verify object size and SHA-256 before marking a row as `r2`.
8. Retain PostgreSQL chunks during a validation period.
9. Remove PostgreSQL chunks only after production validation and explicit approval.

## Safety rules

- Never delete a PostgreSQL chunk solely because an R2 upload succeeded.
- Never mark an object as ready without verifying its existence and expected size.
- Preserve the existing per-user audio deduplication behavior.
- Coordinate database updates and R2 operations explicitly; they are not transactional together.
- Track failed deletions so objects can be retried without leaving orphaned references.
- Keep the uploads bucket private; authorize downloads through authenticated backend routes.

## Next implementation step

Wire `putBeatAsset`, `getBeatAsset` and `deleteBeatAsset` into `beat-library.js`, then map all upload, read, pack and deletion paths before enabling the migration.

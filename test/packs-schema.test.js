import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'

import { setupPacksSchema } from '../packs-schema.js'

function createDb(pg) {
  const query = async (sql, params) => {
    const result = await pg.query(sql, params)

    return {
      ...result,
      rowCount: result.affectedRows || result.rows.length
    }
  }

  return { query }
}

async function createBaseSchema(db) {
  await db.query(`
    CREATE TABLE account_users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL
    )
  `)

  await db.query(`
    CREATE TABLE account_beats (
      id UUID PRIMARY KEY,
      user_id INTEGER NOT NULL
        REFERENCES account_users(id)
        ON DELETE CASCADE,
      title TEXT NOT NULL
    )
  `)
}

test(
  'pack schema is idempotent and preserves pack integrity',
  async () => {
    const pg = new PGlite()
    const db = createDb(pg)

    try {
      await createBaseSchema(db)

      await setupPacksSchema(db)
      await setupPacksSchema(db)

      await db.query(`
        INSERT INTO account_users (id, email, handle)
        VALUES
          (1, 'one@example.com', NULL),
          (2, 'two@example.com', 'tof')
      `)

      const nullHandle = await db.query(`
        SELECT handle
        FROM account_users
        WHERE id = 1
      `)

      assert.equal(nullHandle.rows[0].handle, null)

      await assert.rejects(
        db.query(`
          INSERT INTO account_users (id, email, handle)
          VALUES (3, 'three@example.com', 'TOF')
        `),
        /unique/i
      )

      await assert.rejects(
        db.query(`
          INSERT INTO account_packs (id, user_id, name)
          VALUES (
            '11111111-1111-1111-1111-111111111111',
            999,
            'Missing owner'
          )
        `),
        /foreign key/i
      )

      await db.query(`
        INSERT INTO account_beats (id, user_id, title)
        VALUES (
          '22222222-2222-2222-2222-222222222222',
          1,
          'Test beat'
        )
      `)

      await db.query(`
        INSERT INTO account_packs (id, user_id, name)
        VALUES (
          '33333333-3333-3333-3333-333333333333',
          1,
          'Test pack'
        )
      `)

      await assert.rejects(
        db.query(`
          INSERT INTO account_packs (id, user_id, name)
          VALUES (
            '44444444-4444-4444-4444-444444444444',
            1,
            '   '
          )
        `),
        /check/i
      )

      await assert.rejects(
        db.query(
          `
            INSERT INTO account_packs (id, user_id, name)
            VALUES (
              '55555555-5555-5555-5555-555555555555',
              1,
              $1
            )
          `,
          ['a'.repeat(101)]
        ),
        /check/i
      )

      await assert.rejects(
        db.query(`
          INSERT INTO account_pack_beats (pack_id, beat_id)
          VALUES (
            '99999999-9999-9999-9999-999999999999',
            '22222222-2222-2222-2222-222222222222'
          )
        `),
        /foreign key/i
      )

      await assert.rejects(
        db.query(`
          INSERT INTO account_pack_beats (pack_id, beat_id)
          VALUES (
            '33333333-3333-3333-3333-333333333333',
            '99999999-9999-9999-9999-999999999999'
          )
        `),
        /foreign key/i
      )

      await db.query(`
        INSERT INTO account_pack_beats (pack_id, beat_id)
        VALUES (
          '33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222222'
        )
      `)

      await assert.rejects(
        db.query(`
          INSERT INTO account_pack_beats (pack_id, beat_id)
          VALUES (
            '33333333-3333-3333-3333-333333333333',
            '22222222-2222-2222-2222-222222222222'
          )
        `),
        /unique|duplicate/i
      )

      await db.query(`
        DELETE FROM account_packs
        WHERE id = '33333333-3333-3333-3333-333333333333'
      `)

      const beatAfterPackDelete = await db.query(`
        SELECT id
        FROM account_beats
        WHERE id = '22222222-2222-2222-2222-222222222222'
      `)

      assert.equal(beatAfterPackDelete.rowCount, 1)

      const linksAfterPackDelete = await db.query(`
        SELECT pack_id
        FROM account_pack_beats
        WHERE beat_id = '22222222-2222-2222-2222-222222222222'
      `)

      assert.equal(linksAfterPackDelete.rowCount, 0)

      await db.query(`
        INSERT INTO account_packs (id, user_id, name)
        VALUES (
          '66666666-6666-6666-6666-666666666666',
          1,
          'Second pack'
        )
      `)

      await db.query(`
        INSERT INTO account_pack_beats (pack_id, beat_id)
        VALUES (
          '66666666-6666-6666-6666-666666666666',
          '22222222-2222-2222-2222-222222222222'
        )
      `)

      await db.query(`
        DELETE FROM account_beats
        WHERE id = '22222222-2222-2222-2222-222222222222'
      `)

      const linksAfterBeatDelete = await db.query(`
        SELECT pack_id
        FROM account_pack_beats
        WHERE pack_id = '66666666-6666-6666-6666-666666666666'
      `)

      assert.equal(linksAfterBeatDelete.rowCount, 0)

      await db.query(`
        INSERT INTO account_beats (id, user_id, title)
        VALUES (
          '77777777-7777-7777-7777-777777777777',
          2,
          'Second user beat'
        )
      `)

      await db.query(`
        INSERT INTO account_packs (id, user_id, name)
        VALUES (
          '88888888-8888-8888-8888-888888888888',
          2,
          'Second user pack'
        )
      `)

      await db.query(`
        INSERT INTO account_pack_beats (pack_id, beat_id)
        VALUES (
          '88888888-8888-8888-8888-888888888888',
          '77777777-7777-7777-7777-777777777777'
        )
      `)

      await db.query(`
        DELETE FROM account_users
        WHERE id = 2
      `)

      const packsAfterUserDelete = await db.query(`
        SELECT id
        FROM account_packs
        WHERE user_id = 2
      `)

      const linksAfterUserDelete = await db.query(`
        SELECT pack_id
        FROM account_pack_beats
        WHERE pack_id = '88888888-8888-8888-8888-888888888888'
      `)

      assert.equal(packsAfterUserDelete.rowCount, 0)
      assert.equal(linksAfterUserDelete.rowCount, 0)
    } finally {
      await pg.close()
    }
  }
)

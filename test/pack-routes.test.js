import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'

import { setupPacksSchema } from '../packs-schema.js'
import { createPackRouter } from '../routes/pack-routes.js'

const USER_ONE = 1
const USER_TWO = 2

const PACK_ONE =
  '11111111-1111-1111-1111-111111111111'
const PACK_TWO =
  '22222222-2222-2222-2222-222222222222'
const BEAT_ONE =
  '33333333-3333-3333-3333-333333333333'
const BEAT_TWO =
  '44444444-4444-4444-4444-444444444444'

function createDb(pg) {
  return {
    query: async (sql, params) => {
      const result = await pg.query(sql, params)

      return {
        ...result,
        rowCount:
          result.affectedRows ||
          result.rows.length
      }
    },
    connect: async () => {
      const client = await pg.getConnection()

      return {
        query: client.query,
        release: client.release
      }
    }
  }
}

async function createTestApp() {
  const pg = new PGlite()
  const db = createDb(pg)

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

  await setupPacksSchema(db)

  await db.query(`
    INSERT INTO account_users (id, email)
    VALUES
      ($1, 'one@example.com'),
      ($2, 'two@example.com')
  `, [USER_ONE, USER_TWO])

  await db.query(`
    INSERT INTO account_beats (id, user_id, title)
    VALUES
      ($1, $2, 'Beat one'),
      ($3, $2, 'Beat two')
  `, [BEAT_ONE, USER_ONE, BEAT_TWO])

  const accounts = new Map([
    ['user-one-token', { id: USER_ONE }],
    ['user-two-token', { id: USER_TWO }]
  ])

  const getAccountFromRequest = async req => {
    const authorization =
      req.headers.authorization || ''

    if (!authorization.startsWith('Bearer ')) {
      return null
    }

    return accounts.get(
      authorization.slice(7)
    ) || null
  }

  const app = express()

  app.use(express.json())

  app.use(
    createPackRouter({
      db,
      getAccountFromRequest
    })
  )

  return {
    app,
    db,
    close: () => pg.close()
  }
}

async function request(app, options) {
  const {
    method = 'GET',
    path,
    token,
    body
  } = options

  const response = await app.fetch(
    path,
    {
      method,
      headers: {
        ...(token
          ? { authorization: `Bearer ${token}` }
          : {}),
        ...(body
          ? { 'content-type': 'application/json' }
          : {})
      },
      body: body
        ? JSON.stringify(body)
        : undefined
    }
  )

  let json = null

  try {
    json = await response.json()
  } catch {
    json = null
  }

  return {
    status: response.status,
    body: json
  }
}

test(
  'private pack routes require authentication',
  async () => {
    const { app, close } =
      await createTestApp()

    try {
      const response = await request(app, {
        path: '/api/me/packs'
      })

      assert.equal(response.status, 401)
      assert.equal(
        response.body.authenticated,
        false
      )
    } finally {
      await close()
    }
  }
)

test(
  'user can create, read, update and delete own pack',
  async () => {
    const { app, db, close } =
      await createTestApp()

    try {
      const created = await request(app, {
        method: 'POST',
        path: '/api/me/packs',
        token: 'user-one-token',
        body: {
          name: '  Friday Pack  '
        }
      })

      assert.equal(created.status, 201)
      assert.equal(
        created.body.pack.name,
        'Friday Pack'
      )

      const packId = created.body.pack.id

      const listed = await request(app, {
        path: '/api/me/packs',
        token: 'user-one-token'
      })

      assert.equal(listed.status, 200)
      assert.equal(
        listed.body.packs.length,
        1
      )
      assert.equal(
        listed.body.packs[0].id,
        packId
      )
      assert.equal(
        listed.body.packs[0].beat_count,
        0
      )

      const updated = await request(app, {
        method: 'PATCH',
        path: `/api/me/packs/${packId}`,
        token: 'user-one-token',
        body: {
          name: 'Weekend Pack'
        }
      })

      assert.equal(updated.status, 200)
      assert.equal(
        updated.body.pack.name,
        'Weekend Pack'
      )

      const deleted = await request(app, {
        method: 'DELETE',
        path: `/api/me/packs/${packId}`,
        token: 'user-one-token'
      })

      assert.equal(deleted.status, 200)

      const afterDelete =
        await request(app, {
          path: '/api/me/packs',
          token: 'user-one-token'
        })

      assert.equal(
        afterDelete.body.packs.length,
        0
      )
    } finally {
      await close()
    }
  }
)

test(
  'pack remains private to its owner',
  async () => {
    const { app, close } =
      await createTestApp()

    try {
      const created = await request(app, {
        method: 'POST',
        path: '/api/me/packs',
        token: 'user-one-token',
        body: {
          name: 'Private pack'
        }
      })

      const packId = created.body.pack.id

      const otherUserUpdate =
        await request(app, {
          method: 'PATCH',
          path: `/api/me/packs/${packId}`,
          token: 'user-two-token',
          body: {
            name: 'Hacked'
          }
        })

      assert.equal(
        otherUserUpdate.status,
        404
      )

      const otherUserDelete =
        await request(app, {
          method: 'DELETE',
          path: `/api/me/packs/${packId}`,
          token: 'user-two-token'
        })

      assert.equal(
        otherUserDelete.status,
        404
      )

      const otherUserList =
        await request(app, {
          path: '/api/me/packs',
          token: 'user-two-token'
        })

      assert.equal(
        otherUserList.body.packs.length,
        0
      )
    } finally {
      await close()
    }
  }
)

test(
  'pack can include only beats owned by the same user',
  async () => {
    const { app, db, close } =
      await createTestApp()

    try {
      const created = await request(app, {
        method: 'POST',
        path: '/api/me/packs',
        token: 'user-one-token',
        body: {
          name: 'Beat pack'
        }
      })

      const packId = created.body.pack.id

      const added = await request(app, {
        method: 'POST',
        path: `/api/me/packs/${packId}/beats`,
        token: 'user-one-token',
        body: {
          beatId: BEAT_ONE
        }
      })

      assert.equal(added.status, 201)
      assert.equal(
        added.body.alreadyAdded,
        false
      )

      const repeated = await request(app, {
        method: 'POST',
        path: `/api/me/packs/${packId}/beats`,
        token: 'user-one-token',
        body: {
          beatId: BEAT_ONE
        }
      })

      assert.equal(repeated.status, 200)
      assert.equal(
        repeated.body.alreadyAdded,
        true
      )

      const links = await db.query(`
        SELECT beat_id
        FROM account_pack_beats
        WHERE pack_id = $1
      `, [packId])

      assert.equal(links.rows.length, 1)

      const removed = await request(app, {
        method: 'DELETE',
        path:
          `/api/me/packs/${packId}/beats/${BEAT_ONE}`,
        token: 'user-one-token'
      })

      assert.equal(removed.status, 200)

      const beatsAfterRemove =
        await db.query(`
          SELECT id
          FROM account_beats
          WHERE id = $1
        `, [BEAT_ONE])

      assert.equal(
        beatsAfterRemove.rows.length,
        1
      )

      const linksAfterRemove =
        await db.query(`
          SELECT beat_id
          FROM account_pack_beats
          WHERE pack_id = $1
        `, [packId])

      assert.equal(
        linksAfterRemove.rows.length,
        0
      )
    } finally {
      await close()
    }
  }
)

test(
  'deleting a pack preserves its beats',
  async () => {
    const { app, db, close } =
      await createTestApp()

    try {
      const created = await request(app, {
        method: 'POST',
        path: '/api/me/packs',
        token: 'user-one-token',
        body: {
          name: 'Deletable pack',
          beatId: BEAT_ONE
        }
      })

      assert.equal(created.status, 201)

      const packId = created.body.pack.id

      const deleted = await request(app, {
        method: 'DELETE',
        path: `/api/me/packs/${packId}`,
        token: 'user-one-token'
      })

      assert.equal(deleted.status, 200)

      const beat = await db.query(`
        SELECT id
        FROM account_beats
        WHERE id = $1
      `, [BEAT_ONE])

      assert.equal(beat.rows.length, 1)

      const links = await db.query(`
        SELECT pack_id
        FROM account_pack_beats
        WHERE beat_id = $1
      `, [BEAT_ONE])

      assert.equal(links.rows.length, 0)
    } finally {
      await close()
    }
  }
)

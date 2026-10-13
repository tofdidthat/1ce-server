import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'

import { setupPacksSchema } from '../packs-schema.js'
import { createPackRouter } from '../routes/pack-routes.js'

const USER_ONE = 1
const USER_TWO = 2

const BEAT_ONE =
  '33333333-3333-3333-3333-333333333333'
const BEAT_TWO =
  '44444444-4444-4444-4444-444444444444'

function toQueryResult(result) {
  return {
    ...result,
    rowCount:
      result.affectedRows ||
      result.rows.length
  }
}

function createDb(pg) {
  return {
    query: async (sql, params) => {
      const result = await pg.query(sql, params)

      return toQueryResult(result)
    },

    connect: async () => ({
      query: async (sql, params) => {
        const result = await pg.query(sql, params)

        return toQueryResult(result)
      },

      release: () => {}
    })
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

  await db.query(
    `
      INSERT INTO account_users (id, email)
      VALUES
        ($1, 'one@example.com'),
        ($2, 'two@example.com')
    `,
    [USER_ONE, USER_TWO]
  )

  await db.query(
    `
      INSERT INTO account_beats (
        id,
        user_id,
        title
      )
      VALUES
        ($1, $2, 'Beat one'),
        ($3, $2, 'Beat two')
    `,
    [BEAT_ONE, USER_ONE, BEAT_TWO]
  )

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
    '/api',
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

  const server = await new Promise(resolve => {
    const listener = app.listen(
      0,
      '127.0.0.1',
      () => resolve(listener)
    )
  })

  try {
    const address = server.address()

    const response = await fetch(
      `http://127.0.0.1:${address.port}${path}`,
      {
        method,

        headers: {
          ...(token
            ? {
                authorization:
                  `Bearer ${token}`
              }
            : {}),

          ...(body
            ? {
                'content-type':
                  'application/json'
              }
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
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
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
    const { app, close } =
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

      const afterDelete = await request(app, {
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

      assert.equal(created.status, 201)

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
        otherUserList.status,
        200
      )

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

      assert.equal(created.status, 201)

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

      const repeated = await request

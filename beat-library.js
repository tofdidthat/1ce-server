import crypto from 'node:crypto'
import fs from 'node:fs'
import multer from 'multer'
import {validateStemsZip} from './stems-zip.js'
import { coverUrlFromKey } from './services/cover-url.js'
import { createUploadStorage } from './services/upload-storage.js'

const chunkSize=1024*1024
const beatStorage=createUploadStorage()

function isR2ConfigurationError(error){
  return String(error?.message || '').startsWith('R2 upload storage is not configured.')
}

async function deleteBeatObject(key){
  if(!key)return
  try{
    await beatStorage.deleteBeatAsset({key})
  }catch(error){
    console.error('Failed to delete R2 beat asset:',error.message)
  }
}

async function uploadBeatAsset(userId,beatId,kind,file){
  const stat=fs.statSync(file.path)
  const contentType=kind==='stems'?'application/zip':'audio/mpeg'
  try{
    return await beatStorage.putBeatAsset({
      userId,
      beatId,
      kind,
      body:fs.createReadStream(file.path),
      contentType,
      contentLength:stat.size
    })
  }catch(error){
    if(isR2ConfigurationError(error)){
      return {storage:'postgres'}
    }
    throw error
  }
}

export async function setupBeatLibrary(db){
 await db.query(`CREATE TABLE IF NOT EXISTS account_beats(id UUID PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,title TEXT NOT NULL,audio_hash TEXT NOT NULL,audio_size INTEGER NOT NULL,duration DOUBLE PRECISION,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,audio_hash))`)
 await db.query(`CREATE TABLE IF NOT EXISTS account_beat_audio(beat_id UUID NOT NULL REFERENCES account_beats(id) ON DELETE CASCADE,chunk_index INTEGER NOT NULL,data BYTEA NOT NULL,PRIMARY KEY(beat_id,chunk_index))`)
 await db.query('ALTER TABLE account_beats ADD COLUMN IF NOT EXISTS stems_name TEXT')
 await db.query('ALTER TABLE account_beats ADD COLUMN IF NOT EXISTS stems_size INTEGER')
 await db.query('ALTER TABLE account_beats ADD COLUMN IF NOT EXISTS stems_hash TEXT')
 await db.query('ALTER TABLE account_beats ADD COLUMN IF NOT EXISTS profile_hidden BOOLEAN NOT NULL DEFAULT FALSE')
 await db.query(`
  ALTER TABLE account_beats
  ADD COLUMN IF NOT EXISTS library_visible
  BOOLEAN NOT NULL DEFAULT TRUE
`)
 await db.query('ALTER TABLE account_beats ADD COLUMN IF NOT EXISTS cover_key TEXT')
 await db.query(`CREATE TABLE IF NOT EXISTS account_beat_stems(beat_id UUID NOT NULL REFERENCES account_beats(id) ON DELETE CASCADE,chunk_index INTEGER NOT NULL,data BYTEA NOT NULL,PRIMARY KEY(beat_id,chunk_index))`)
 await db.query('ALTER TABLE account_beats ADD COLUMN IF NOT EXISTS audio_storage TEXT NOT NULL DEFAULT \'postgres\'')
 await db.query('ALTER TABLE account_beats ADD COLUMN IF NOT EXISTS audio_object_key TEXT')
 await db.query('ALTER TABLE account_beats ADD COLUMN IF NOT EXISTS stems_storage TEXT NOT NULL DEFAULT \'postgres\'')
 await db.query('ALTER TABLE account_beats ADD COLUMN IF NOT EXISTS stems_object_key TEXT')
 await db.query('CREATE INDEX IF NOT EXISTS account_beats_user_date_idx ON account_beats(user_id,created_at DESC)')
}

export async function saveDesktopBeat(
  db,
  userId,
  file,
  duration,
  stems,
  options = {}
) {
  const libraryVisible = options.libraryVisible !== false
  const digest=crypto.createHash('sha256')
 for await(const chunk of fs.createReadStream(file.path))digest.update(chunk)
 const audioHash=digest.digest('hex')
 const title=String(file.originalname || 'Untitled beat').split(/[\\/]/).pop().replace(/\.mp3$/i,'').trim().slice(0,100) || 'Untitled beat'
 const beatId=crypto.randomUUID()
 const audioUpload=await uploadBeatAsset(userId,beatId,'audio',file)
 const client=await db.connect()
 let oldStemsKey
 let stemsUpload
 try{
  await client.query('BEGIN')
  const row=await client.query(
   `INSERT INTO account_beats (
      id,
      user_id,
      title,
      audio_hash,
      audio_size,
      duration,
      library_visible,
      audio_storage,
      audio_object_key
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (user_id,audio_hash)
    DO NOTHING
    RETURNING id,title,created_at,duration,library_visible`,
   [
    beatId,
    userId,
    title,
    audioHash,
    fs.statSync(file.path).size,
    Number.isFinite(Number(duration))?Number(duration):null,
    libraryVisible,
    audioUpload.storage,
    audioUpload.key || null
   ]
  )
  if(!row.rowCount){
   const existing=await client.query(
    `SELECT id,title,created_at,duration,library_visible
     FROM account_beats
     WHERE user_id=$1 AND audio_hash=$2`,
    [userId,audioHash]
   )
   row.rows=existing.rows
   if(audioUpload.key)await deleteBeatObject(audioUpload.key)
  }else if(audioUpload.storage==='postgres'){
   let index=0
   for await(const chunk of fs.createReadStream(file.path,{highWaterMark:chunkSize})){
    await client.query(
     `INSERT INTO account_beat_audio(beat_id,chunk_index,data)
      VALUES ($1,$2,$3)`,
     [row.rows[0].id,index++,chunk]
    )
   }
  }
  if(libraryVisible){
   await client.query(
    `UPDATE account_beats
     SET library_visible=TRUE
     WHERE id=$1 AND user_id=$2`,
    [row.rows[0].id,userId]
   )
   row.rows[0].library_visible=true
  }
  if(stems){
   const beat=row.rows[0]
   const locked=await client.query(
    'SELECT stems_object_key FROM account_beats WHERE id=$1 AND user_id=$2 FOR UPDATE',
    [beat.id,userId]
   )
   if(!locked.rowCount)throw new Error('Beat not found for stems upload.')
   oldStemsKey=locked.rows[0].stems_object_key
   stemsUpload=await uploadBeatAsset(userId,beat.id,'stems',stems)
   const hash=crypto.createHash('sha256')
   for await(const chunk of fs.createReadStream(stems.path))hash.update(chunk)
   await client.query('DELETE FROM account_beat_stems WHERE beat_id=$1',[beat.id])
   if(stemsUpload.storage==='postgres'){
    let index=0
    for await(const chunk of fs.createReadStream(stems.path,{highWaterMark:chunkSize})){
     await client.query(
      'INSERT INTO account_beat_stems(beat_id,chunk_index,data) VALUES($1,$2,$3)',
      [beat.id,index++,chunk]
     )
    }
   }
   const name=String(stems.originalname || 'stems.zip').split(/[\\\\/]/).pop().replace(/[\r\n\u0000-\u001f]/g,'').slice(0,220)
   const size=fs.statSync(stems.path).size
   await client.query(
    `UPDATE account_beats
     SET stems_name=$1,
         stems_size=$2,
         stems_hash=$3,
         stems_storage=$4,
         stems_object_key=$5
     WHERE id=$6 AND user_id=$7`,
    [name,size,hash.digest('hex'),stemsUpload.storage,stemsUpload.key || null,beat.id,userId]
   )
   beat.stems_name=name
   beat.stems_size=size
  }
  await client.query('COMMIT')
  if(oldStemsKey)await deleteBeatObject(oldStemsKey)
  return row.rows[0]
 }catch(error){
  try{await client.query('ROLLBACK')}catch{}
  if(audioUpload?.key)await deleteBeatObject(audioUpload.key)
  if(stemsUpload?.key)await deleteBeatObject(stemsUpload.key)
  throw error
 }finally{
  client.release()
 }
}

export function audioRange(header,size){
 if(!header)return {start:0,end:size-1,partial:false}
 const match=/^bytes=(\d*)-(\d*)$/.exec(header)
 if(!match || (!match[1] && !match[2]))return null
 const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]))
 const end=match[1]?(match[2]?Math.min(Number(match[2]),size-1):size-1):size-1
 return Number.isSafeInteger(start)&&start>=0&&start<size&&end>=start?{start,end,partial:true}:null
}

export function registerBeatLibrary(router,{db,account}){
router.get('/beats', account, async (req, res, next) => {
  try {
    const result = await db.query(
      `
        SELECT
          id,
          title,
          created_at,
          duration,
          audio_size,
          stems_name,
          stems_size,
          profile_hidden,
          cover_key
        FROM account_beats
        WHERE user_id = $1
        ORDER BY created_at DESC, id
      `,
      [req.account.id]
    )

    const beats = result.rows.map(row => {
      const { cover_key, ...beat } = row

      return {
        ...beat,
        cover_url: coverUrlFromKey(cover_key)
      }
    })

    res.setHeader('Cache-Control', 'no-store')

    return res.json({ beats })
  } catch (error) {
    next(error)
  }
})

router.delete('/beats/:id', account, async (req, res, next) => {
  try{
   if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(req.params.id))return res.sendStatus(404)
   const keys=await db.query(
    'SELECT audio_object_key,stems_object_key FROM account_beats WHERE id=$1 AND user_id=$2',
    [req.params.id,req.account.id]
   )
   if(!keys.rowCount)return res.sendStatus(404)
   const result=await db.query(
    'DELETE FROM account_beats WHERE id=$1 AND user_id=$2 RETURNING id',
    [req.params.id,req.account.id]
   )
   if(result.rowCount){
    await deleteBeatObject(keys.rows[0].audio_object_key)
    await deleteBeatObject(keys.rows[0].stems_object_key)
   }
   res.sendStatus(result.rowCount?204:404)
  }catch(error){next(error)}
})

router.patch('/beats/:id',account,async(req,res,next)=>{
  try{
   if(!/^[a-f0-9-]{36}$/i.test(req.params.id))return res.sendStatus(404)
   const title=typeof req.body?.title==='string'?req.body.title.trim():''
   const profileHidden=typeof req.body?.profileHidden==='boolean'?req.body.profileHidden:null
   if(!title && profileHidden===null)return res.status(400).json({error:'Provide a title or profileHidden.'})
   if(title && title.length>100)return res.status(400).json({error:'A title between 1 and 100 characters is required.'})
   const sets=[];const values=[req.params.id,req.account.id]
   if(title){sets.push('title=$'+(values.length+1));values.push(title)}
   if(profileHidden!==null){sets.push('profile_hidden=$'+(values.length+1));values.push(profileHidden)}
   const result=await db.query('UPDATE account_beats SET '+sets.join(',')+' WHERE id=$1 AND user_id=$2 RETURNING id,title,created_at,duration,profile_hidden',values)
   if(!result.rowCount)return res.sendStatus(404)
   res.json({beat:result.rows[0]})
  }catch(error){next(error)}
})

const stemsUpload=multer({storage:multer.diskStorage({}),limits:{fileSize:500*1024*1024,files:1,fields:0,parts:1}}).single('stems')
router.post('/beats/:id/stems',account,(req,res,next)=>stemsUpload(req,res,async error=>{
 const file=req.file
 const cleanup=()=>{if(file?.path)try{fs.unlinkSync(file.path)}catch{}}
 if(error){cleanup();return res.status(error.code==='LIMIT_FILE_SIZE'?413:400).json({error:'Invalid stems upload.'})}
 try{
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(req.params.id)){cleanup();return res.sendStatus(404)}
  if(!file){cleanup();return res.status(400).json({error:'Stems ZIP is required.'})}
  try{await validateStemsZip(file)}catch(error){cleanup();return res.status(400).json({error:'Invalid stems ZIP: '+error.message})}
  const beatId=req.params.id
  const upload=await uploadBeatAsset(req.account.id,beatId,'stems',file)
  const hash=crypto.createHash('sha256')
  for await(const chunk of fs.createReadStream(file.path))hash.update(chunk)
  const client=await db.connect()
  let oldKey
  try{
   await client.query('BEGIN')
   const beat=await client.query(
    'SELECT stems_object_key FROM account_beats WHERE id=$1 AND user_id=$2 FOR UPDATE',
    [beatId,req.account.id]
   )
   if(!beat.rowCount){await client.query('ROLLBACK');if(upload.key)await deleteBeatObject(upload.key);return res.sendStatus(404)}
   oldKey=beat.rows[0].stems_object_key
   await client.query('DELETE FROM account_beat_stems WHERE beat_id=$1',[beatId])
   if(upload.storage==='postgres'){
    let index=0
    for await(const chunk of fs.createReadStream(file.path,{highWaterMark:chunkSize})){
     await client.query(
      'INSERT INTO account_beat_stems(beat_id,chunk_index,data) VALUES($1,$2,$3)',
      [beatId,index++,chunk]
     )
    }
   }
   const name=String(file.originalname || 'stems.zip').split(/[\\\\/]/).pop().replace(/[\r\n\u0000-\u001f]/g,'').slice(0,220)
   const size=fs.statSync(file.path).size
   await client.query(
    `UPDATE account_beats
     SET stems_name=$1,
         stems_size=$2,
         stems_hash=$3,
         stems_storage=$4,
         stems_object_key=$5
     WHERE id=$6 AND user_id=$7`,
    [name,size,hash.digest('hex'),upload.storage,upload.key || null,beatId,req.account.id]
   )
   await client.query('COMMIT')
   if(oldKey)await deleteBeatObject(oldKey)
   res.status(201).json({ok:true,stems_name:name,stems_size:size})
  }catch(error){
   try{await client.query('ROLLBACK')}catch{}
   if(upload.key)await deleteBeatObject(upload.key)
   throw error
  }finally{
   client.release()
  }
 }catch(error){next(error)}finally{cleanup()}
}))

router.get('/beats/:id/audio',account,privateAsset('audio'))
router.get('/beats/:id/stems',account,privateAsset('stems'))

function privateAsset(kind){
 return async(req,res,next)=>{
  let client
  try{
   if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(req.params.id))return res.sendStatus(404)
   client=await db.connect()
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
   const result=await client.query(
    `SELECT audio_size,stems_size,stems_name,
            audio_storage,audio_object_key,
            stems_storage,stems_object_key
     FROM account_beats
     WHERE id=$1 AND user_id=$2`,
    [req.params.id,req.account.id]
   )
   if(!result.rowCount)return res.sendStatus(404)
   const beat=result.rows[0]
   const size=kind==='stems'?beat.stems_size:beat.audio_size
   if(!size)return res.sendStatus(404)
   const storage=kind==='stems'?beat.stems_storage:beat.audio_storage
   const objectKey=kind==='stems'?beat.stems_object_key:beat.audio_object_key
   res.setHeader('Accept-Ranges','bytes')
   res.setHeader('Content-Type',kind==='stems'?'application/zip':'audio/mpeg')
   if(kind==='stems')res.setHeader('Content-Disposition',"attachment; filename=\"stems.zip\"; filename*=UTF-8''"+encodeURIComponent(beat.stems_name || 'stems.zip').replace(/'/g,'%27'))
   if(storage==='r2'&&objectKey){
    const object=await beatStorage.getBeatAsset({key:objectKey,range:req.headers.range})
    res.status(object.ContentRange?206:200)
    if(object.ContentLength!=null)res.setHeader('Content-Length',String(object.ContentLength))
    if(object.ContentRange)res.setHeader('Content-Range',object.ContentRange)
    object.Body.pipe(res)
    return
   }
   const range=audioRange(req.headers.range,size)
   if(!range){res.setHeader('Content-Range','bytes */'+size);return res.sendStatus(416)}
   const {start,end,partial}=range
   res.status(partial?206:200)
   res.setHeader('Content-Length',end-start+1)
   if(partial)res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`)
   const table=kind==='stems'?'account_beat_stems':'account_beat_audio'
   for(let index=Math.floor(start/chunkSize);index<=Math.floor(end/chunkSize);index++){
    if(res.destroyed)return
    const chunk=await client.query('SELECT data FROM '+table+' WHERE beat_id=$1 AND chunk_index=$2',[req.params.id,index])
    if(!chunk.rowCount)throw Error('Missing media chunk')
    const bytes=Buffer.from(chunk.rows[0].data),offset=index*chunkSize
    if(!res.write(bytes.subarray(Math.max(0,start-offset),Math.min(bytes.length,end-offset+1))))await new Promise(resolve=>{
     const done=()=>{res.off('drain',done);res.off('close',done);resolve()}
     res.once('drain',done)
     res.once('close',done)
     resolve()
    })
   }
   res.end()
  }catch(error){if(res.headersSent)res.destroy(error);else next(error)}
  finally{if(client){try{await client.query('ROLLBACK')}finally{client.release()}}}
 }
}
}

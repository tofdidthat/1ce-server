# 1ce Server

Backend de renderização e publicação do **1ce**.

Este serviço processa mídias enviadas pelo app, gera vídeos verticais 9:16 e expõe os endpoints usados pelo frontend para autenticação, upload, renderização e publicação.

## Stack

- Node.js
- Express
- PostgreSQL
- FFmpeg
- Sharp
- AWS S3

## Execução

```bash
npm install
npm start
```

## Testes

```bash
npm test
```

## Deploy

O serviço é implantado no Railway e consome as variáveis de ambiente configuradas no projeto.

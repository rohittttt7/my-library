# Ruby's Signature Learning Portal

English Tutorial is the homepage. Hindi Tutorial, Workflows, and Description each have their own library. Search and filters apply to the page you are viewing.

## Run on Windows

1. Install Node.js 22.19 or later.
2. In PowerShell, open this project folder and run `npm.cmd start`.
3. Open [the local portal](http://localhost:3000). It opens straight to the library with editing controls available.

The app listens only on this computer's loopback address. Anyone who can use the app on this computer can edit the library. Keep it off a public network while it runs without sign-in.

## Manage content

- Select **+ Add Content** in a category or folder. Choose **Upload a file**, **YouTube link**, **Note**, **Microsoft Loop link**, or **Folder**. Give the item a title and an optional description.
- File uploads support PDFs, JPG, PNG, WEBP, GIF, AVIF, Office documents, CSV and text files, audio such as MP3, M4A and WAV, video such as MP4 and WEBM, and ZIP, 7Z and RAR archives. The file limit is 64 MB per upload. Archives and Office files are available as downloads. Audio and video playback depends on the browser's codec support.
- Use **Edit** to change an item or replace its file. **Move up** and **Move down** change an item's position within its folder or category. Move or remove the contents of a folder before deleting that folder.
- YouTube videos can be opened on YouTube when embedding is unavailable. Microsoft Loop opens the original page and uses Microsoft's permissions.

## Existing Render and Supabase library

The Render variant uses the earlier My Library application's `public.library_items` table and its existing Supabase Storage bucket. The default bucket is `library-files`. The PostgreSQL migration adds folders, descriptions, and progress without overwriting existing items or renaming files. The new pages recognize legacy category labels and show other legacy categories under **Description**.

Before deploying over the existing service, check the migration against its actual Supabase schema and take a backup. Apply [the Supabase migration](supabase/migrations/20261123075500_ruby_portal.sql) to the existing project. The old server could send direct public links to Storage. If its bucket is public, coordinate making it private with the Render cutover. The updated service checks the bucket at startup and proxies file access itself. Old direct public links stop working when the bucket becomes private. [Supabase Storage access controls](https://supabase.com/docs/guides/storage/security/access-control)

Use the existing Render web service and its linked GitHub repository and branch to retain the current URL. Set **Auto-Deploy** to **On Commit**. `render.yaml` declares the same setting for services managed by a Blueprint. Run `npm start` to launch the portal. Render supplies `PORT` and `RENDER_EXTERNAL_URL`, and the start command uses those settings to select the Supabase backend. Use Node 22.19 or later and `/healthz` for the health check. [Render GitHub auto-deploy](https://render.com/docs/deploys#automatic-deploys)

Set these values under Environment on the existing service. Keep the credentials in Render's environment settings. [Render environment settings](https://render.com/docs/configure-environment-variables)

- `SUPABASE_URL` is the existing Supabase project's HTTPS URL.
- `SUPABASE_SECRET_KEY` is the server-side Supabase secret. `SUPABASE_SERVICE_ROLE_KEY` also works for a legacy credential.
- `SUPABASE_BUCKET` is the private bucket if it uses a name other than `library-files`.
- `LIBRARY_ACCESS_PASSWORD` is a shared password of at least 16 characters. `LIBRARY_ACCESS_USER` defaults to `ruby`. The browser prompts for this password before opening the portal. The app serves no separate login page.
- `PUBLIC_ORIGIN` is needed only when the service uses a different public address from its Render-provided URL.

The Render variant allows up to 50 MB per file and keeps local SQLite data separate. [Supabase upload limits](https://supabase.com/docs/guides/storage/uploads/file-limits)

## Keep the library on another computer

Install Node.js and run the same app locally on the destination computer. Stop the app before copying the entire `data/` directory so that the SQLite database and its files stay together. You can set `DATA_DIR` in `.env` to choose a different storage location.

For a local Linux Docker host, use host networking so the loopback-only server remains reachable from that host. Keep the data in a named volume.

```sh
docker build -t ruby-signature-portal .
docker run -d --name ruby-signature-portal --network host \
  --restart unless-stopped -v ruby-signature-data:/app/data ruby-signature-portal
```

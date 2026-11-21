# My Library

A shared, mobile-friendly library for PDF files, images, text, audio, video, and YouTube links.

## Features

- Everyone can add, edit, and delete content
- Number-wise and category-wise organization
- Search and sorting
- Local server-side storage
- Mobile and desktop layouts

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

Uploaded files are stored in `data/uploads`, and library information is stored in `data/library.json`.

## Deploy to Render

1. Push this project to GitHub.
2. Create a new Render Web Service.
3. Connect the GitHub repository.
4. Render will use `render.yaml`, `npm install`, and `npm start`.
5. Attach the `library-data` persistent disk to keep uploads and library data.

## Docker deployment

```bash
docker build -t my-library .
docker run -p 3000:3000 -v my-library-data:/data my-library
```

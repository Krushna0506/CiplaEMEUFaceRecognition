import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  const PORT = 3000;

  // API to fetch Drive IDs without CORS issues
  app.get('/api/drive-folder/:id', async (req, res) => {
    try {
      const rootFolderId = req.params.id;
      if (!rootFolderId || rootFolderId === 'null') {
        return res.status(400).json({ error: 'Folder ID is required' });
      }
      const fileMap = new Map<string, { isVideo: boolean; timestamp: number; folderName: string }>();
      const processedFolders = new Set<string>();
      const folderQueue: { id: string; name: string }[] = [{ id: rootFolderId, name: 'Main Folder' }];

      const MAX_FOLDERS = 150;
      let folderCount = 0;
      const apiKey = process.env.GOOGLE_DRIVE_API_KEY;

      while (folderQueue.length > 0 && folderCount < MAX_FOLDERS) {
        const currentFolder = folderQueue.shift()!;
        if (processedFolders.has(currentFolder.id)) continue;
        processedFolders.add(currentFolder.id);
        folderCount++;

        // IF API KEY IS PROVIDED, USE GOOGLE DRIVE API FOR FULL RESULTS
        if (apiKey) {
          try {
            let pageToken = '';
            do {
              const query = encodeURIComponent(`'${currentFolder.id}' in parents and trashed = false`);
              const apiUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=nextPageToken,files(id,name,mimeType,createdTime)&pageSize=1000&key=${apiKey}${pageToken ? `&pageToken=${pageToken}` : ''}`;

              const response = await axios.get(apiUrl, { timeout: 15000 });
              const data = response.data;

              if (data.files) {
                for (const file of data.files) {
                  if (file.mimeType === 'application/vnd.google-apps.folder') {
                    if (!processedFolders.has(file.id) && folderQueue.length < MAX_FOLDERS) {
                      folderQueue.push({ id: file.id, name: file.name });
                    }
                  } else if (file.mimeType.includes('image/') || file.mimeType.includes('video/') || /\.(jpg|jpeg|png|mp4|mov|avi|webp|heic)$/i.test(file.name)) {
                    fileMap.set(file.id, {
                      isVideo: file.mimeType.includes('video') || /\.(mp4|mov|avi|mkv|webm)$/i.test(file.name),
                      timestamp: file.createdTime ? new Date(file.createdTime).getTime() : Date.now(),
                      folderName: currentFolder.name
                    });
                  }
                }
              }
              pageToken = data.nextPageToken || '';
            } while (pageToken);
            continue; // Skip the web scraping fallback if API succeeds
          } catch (apiErr: any) {
            console.warn(`Drive API failed for folder ${currentFolder.id}, falling back to web scraping. Error: ${apiErr.message}`);
          }
        }

        // FALLBACK: PUPPETEER SCRAPING (Bypasses 50 item limit by scrolling)
        console.log(`Starting Puppeteer scrape for folder ${currentFolder.id}...`);
        try {
          const puppeteer = (await import('puppeteer')).default;
          const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
          const page = await browser.newPage();

          await page.setRequestInterception(true);
          page.on('request', req => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
              req.abort();
            } else {
              req.continue();
            }
          });

          await page.goto(`https://drive.google.com/drive/folders/${currentFolder.id}`, { waitUntil: 'networkidle2', timeout: 30000 });

          // Auto-scroll logic using PageDown to load lazy elements universally
          await page.mouse.click(500, 500); // Focus the window

          // Hard loop to ensure deep scrolling without premature breaks
          for (let i = 0; i < 60; i++) {
            await page.keyboard.press('PageDown');
            await new Promise(r => setTimeout(r, 800)); // Wait for lazy load
          }

          // Wait a second for final items to render
          await new Promise(r => setTimeout(r, 1000));

          // Extract the data array
          const html = await page.content();
          await browser.close();

          // Regex parse the full loaded HTML
          const aggressiveIdRegex = /"([a-zA-Z0-9_-]{33})"/g;
          let aMatch;
          while ((aMatch = aggressiveIdRegex.exec(html)) !== null) {
            const id = aMatch[1];
            if (!fileMap.has(id) && !processedFolders.has(id)) {
              const isBlacklisted =
                id.startsWith('AIza') || id.startsWith('AA2Yr') ||
                id.startsWith('RQsi') || id.startsWith('Wk94') ||
                id.startsWith('6L') || id === rootFolderId;

              if (!isBlacklisted && !/^\d+$/.test(id)) {
                // Determine if it looks like a video from context (rough heuristic)
                const isVideo = html.includes(`${id}","video/`);
                fileMap.set(id, { isVideo, timestamp: Date.now(), folderName: currentFolder.name });
              }
            }
          }
          console.log(`Puppeteer found ${fileMap.size} items so far.`);
        } catch (err: any) {
          console.error(`Puppeteer scrape failed for ${currentFolder.id}: ${err.message}`);
          // Last resort fallback (static scrape of single page)
          try {
            const response = await axios.get(`https://drive.google.com/drive/folders/${currentFolder.id}`);
            const html = response.data;
            const aggressiveIdRegex = /"([a-zA-Z0-9_-]{33})"/g;
            let aMatch;
            while ((aMatch = aggressiveIdRegex.exec(html)) !== null) {
              const id = aMatch[1];
              if (!fileMap.has(id) && !processedFolders.has(id) && !id.startsWith('AIza')) {
                fileMap.set(id, { isVideo: false, timestamp: Date.now(), folderName: currentFolder.name });
              }
            }
          } catch (e) { }
        }
      }

      const files = Array.from(fileMap.entries()).map(([id, meta]) => ({
        id,
        url: `/api/proxy-image?id=${id}&original=true`,
        thumb: `/api/proxy-image?id=${id}`,
        downloadUrl: `/api/download?id=${id}`,
        name: `moment_${id}`,
        isVideo: meta.isVideo,
        timestamp: meta.timestamp,
        folderName: meta.folderName
      }));

      console.log(`Scraped ${files.length} items from ${folderCount} folders.`);
      res.json({ files });
    } catch (error: any) {
      console.error('Drive fetch error:', error.message);
      res.status(500).json({ error: 'Failed to fetch folder contents', details: error.message });
    }
  });

  // Proxy endpoint to bypass CORS for face-api.js
  app.get('/api/proxy-image', async (req, res) => {
    try {
      const id = req.query.id as string;
      const original = req.query.original === 'true';

      // Fallback URLs for robustness
      const urls = original
        ? [`https://drive.google.com/uc?export=view&id=${id}`]
        : [
          `https://lh3.googleusercontent.com/d/${id}=w1024`,
          `https://drive.google.com/thumbnail?id=${id}&sz=w1000`,
          `https://drive.google.com/uc?export=view&id=${id}`
        ];

      let lastError = null;
      for (const targetUrl of urls) {
        try {
          const response = await axios.get(targetUrl, {
            responseType: 'stream',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
              'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
              'Referer': 'https://drive.google.com/'
            },
            timeout: 15000,
            validateStatus: (status) => status === 200
          });

          res.set('Content-Type', String(response.headers['content-type'] || 'image/jpeg'));
          res.set('Cache-Control', 'public, max-age=31536000');
          response.data.pipe(res);
          return;
        } catch (e: any) {
          lastError = e;
          continue;
        }
      }

      console.error(`All proxy attempts failed for ID: ${id} - ${lastError?.message}`);
      res.status(lastError?.response?.status || 502).send('Proxy error');
    } catch (error: any) {
      console.error('Proxy error:', error.message);
      res.status(500).send('Proxy error');
    }
  });

  // Download proxy to force JPG format and filename
  app.get('/api/download', async (req, res) => {
    try {
      const id = req.query.id as string;
      const targetUrl = `https://drive.google.com/uc?export=download&id=${id}`;

      const response = await axios.get(targetUrl, {
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      res.set('Content-Type', 'image/jpeg');
      res.set('Content-Disposition', `attachment; filename="cipla_moment_${id}.jpg"`);
      response.data.pipe(res);
    } catch (error: any) {
      console.error('Download error:', error.message);
      res.status(500).send('Download error');
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

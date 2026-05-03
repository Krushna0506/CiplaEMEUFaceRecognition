import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
app.use(cors({ origin: '*' }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** 
 * Validates a string as a real Google Drive file/folder ID.
 * Drive IDs are typically 33 characters, but can range from 25-45.
 * They are alphanumeric and contain underscores/hyphens.
 */
function isValidDriveId(id: string | null | undefined, excludeId?: string): boolean {
  if (!id) return false;
  if (id === excludeId) return false;
  // Strictly enforce Drive ID pattern
  if (!/^[a-zA-Z0-9_-]{25,45}$/.test(id)) return false;
  // Filter out common false positives (pure numbers, hex, or known API prefixes)
  if (/^\d+$/.test(id)) return false;
  if (/^[0-9a-fA-F]+$/.test(id) && id.length < 32) return false;
  const BAD = ['AIza', '6Lez', 'RQsi', 'AA2Y', 'Wk94', 'AAAA', 'ya29', 'GIze', '1pt-', 'none'];
  return !BAD.some(p => id.toLowerCase().startsWith(p.toLowerCase()));
}

/**
 * Fetches ALL file IDs from a public Google Drive folder using the
 * `/embeddedfolderview` endpoint. This is the "Silver Bullet" for scraping
 * because it returns clean server-rendered HTML with ALL files.
 */
async function fetchEmbeddedFolderView(
  folderId: string,
  folderName: string,
  fileMap: Map<string, { isVideo: boolean; timestamp: number; folderName: string }>,
  folderQueue: { id: string; name: string }[],
  processedFolders: Set<string>
): Promise<number> {
  let pageToken = '';
  let pageCount = 0;
  let itemsFoundOnThisFolder = 0;
  const MAX_PAGES = 50;

  console.log(`[EmbeddedView] Deep scanning folder: ${folderName} (${folderId})`);

  do {
    pageCount++;
    const url = `https://drive.google.com/embeddedfolderview?id=${folderId}${pageToken ? `&pagetoken=${pageToken}` : ''}`;

    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        },
      });
      const html = response.data as string;

      // 1. Precise File Extraction: Look for /file/d/ID/view or /file/d/ID
      // This pattern is unique to actual file links and prevents picking up junk IDs.
      const fileMatches = html.matchAll(/\/file\/d\/([a-zA-Z0-9_-]{25,45})/g);
      for (const m of fileMatches) {
        const id = m[1];
        if (isValidDriveId(id, folderId) && !fileMap.has(id)) {
          // Check for video indicators in the surrounding HTML
          const context = html.substring(Math.max(0, html.indexOf(id) - 100), html.indexOf(id) + 200);
          const isVideo = context.includes('video') || context.includes('mp4') || context.includes('mov');

          fileMap.set(id, {
            isVideo,
            timestamp: Date.now(),
            folderName,
          });
          itemsFoundOnThisFolder++;
        }
      }

      // 2. Precise Folder Extraction: Look for /drive/folders/ID
      const folderMatches = html.matchAll(/\/drive\/folders\/([a-zA-Z0-9_-]{25,45})/g);
      for (const m of folderMatches) {
        const id = m[1];
        if (isValidDriveId(id, folderId) && !processedFolders.has(id)) {
          folderQueue.push({ id, name: `Subfolder of ${folderName}` });
        }
      }

      // 3. Find Next Page Token
      // Google uses a specific 'pagetoken' query param for the next batch of files
      const tokenMatch = html.match(/pagetoken=([^"&>\s]+)/i) || html.match(/data-pagetoken="([^"]+)"/);
      const newToken = tokenMatch ? tokenMatch[1] : '';

      if (newToken === pageToken) break; // Avoid infinite loops
      pageToken = newToken;

    } catch (err: any) {
      console.error(`[EmbeddedView] Page ${pageCount} failed: ${err.message}`);
      break;
    }
  } while (pageToken && pageCount < MAX_PAGES);

  return itemsFoundOnThisFolder;
}

// ─── Main Server ──────────────────────────────────────────────────────────────

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;

  // Status endpoint — tells the frontend if the API key is configured
  app.get('/api/status', (_req, res) => {
    const hasApiKey = !!process.env.GOOGLE_DRIVE_API_KEY?.trim();
    res.json({ hasApiKey });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GET /api/drive-folder/:id
  //
  // Fetches ALL items from a public Google Drive folder.
  //
  // Strategy:
  //   1. Google Drive API v3       — unlimited, requires GOOGLE_DRIVE_API_KEY
  //   2. Embedded Folder View      — server-rendered HTML, ALL items, NO key needed ✅
  //   3. Puppeteer + [data-id]     — browser fallback if embedded view fails
  //   4. Static HTTP scrape        — last resort, ~50 items
  // ───────────────────────────────────────────────────────────────────────────
  app.get('/api/drive-folder/:id', async (req, res) => {
    const rootFolderId = req.params.id;
    if (!rootFolderId || rootFolderId === 'null') {
      return res.status(400).json({ error: 'Folder ID is required' });
    }

    const fileMap = new Map<string, { isVideo: boolean; timestamp: number; folderName: string }>();
    const processedFolders = new Set<string>();
    const folderQueue: { id: string; name: string }[] = [{ id: rootFolderId, name: 'Root' }];
    const MAX_FOLDERS = 500;
    let folderCount = 0;
    const apiKey = process.env.GOOGLE_DRIVE_API_KEY?.trim();

    try {

      // ═══════════════════════════════════════════════════════════════════════
      // STRATEGY 1 — Google Drive API v3
      // Unlimited items, correct mimeType detection, fastest.
      // Set GOOGLE_DRIVE_API_KEY in .env to enable.
      // ═══════════════════════════════════════════════════════════════════════
      if (apiKey) {
        console.log(`[Drive API] Fetching all items for folder ${rootFolderId}...`);

        while (folderQueue.length > 0 && folderCount < MAX_FOLDERS) {
          const folder = folderQueue.shift()!;
          if (processedFolders.has(folder.id)) continue;
          processedFolders.add(folder.id);
          folderCount++;

          let pageToken = '';
          do {
            try {
              const q = encodeURIComponent(`'${folder.id}' in parents and trashed = false`);
              const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,createdTime)');
              const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000&key=${apiKey}${pageToken ? `&pageToken=${pageToken}` : ''}`;
              const { data } = await axios.get(url, { timeout: 20000 });

              for (const file of data.files ?? []) {
                if (file.mimeType === 'application/vnd.google-apps.folder') {
                  if (!processedFolders.has(file.id) && folderQueue.length < MAX_FOLDERS) {
                    folderQueue.push({ id: file.id, name: file.name });
                  }
                } else {
                  const isImg = file.mimeType?.includes('image/') ||
                    /\.(jpg|jpeg|png|gif|bmp|webp|heic|heif|tiff?)$/i.test(file.name ?? '');
                  const isVid = file.mimeType?.includes('video/') ||
                    /\.(mp4|mov|avi|mkv|webm|m4v|3gp)$/i.test(file.name ?? '');
                  if (isImg || isVid) {
                    fileMap.set(file.id, {
                      isVideo: isVid,
                      timestamp: file.createdTime ? new Date(file.createdTime).getTime() : Date.now(),
                      folderName: folder.name,
                    });
                  }
                }
              }
              pageToken = data.nextPageToken || '';
            } catch (err: any) {
              console.warn(`[Drive API] Error: ${err.message}`);
              pageToken = '';
            }
          } while (pageToken);
        }
        console.log(`[Drive API] ✅ Done — ${fileMap.size} items from ${folderCount} folders.`);

      } else {

        // ═══════════════════════════════════════════════════════════════════
        // STRATEGY 2 — Google Drive Embedded Folder View (No API Key)
        //
        //   URL: https://drive.google.com/embeddedfolderview?id=FOLDER_ID
        //
        //   This endpoint returns server-rendered HTML (NOT virtualized).
        //   ALL files appear as href="/file/d/FILE_ID/view" links.
        //   Works for any publicly shared folder without authentication.
        //   Supports pagination via pagetoken query param.
        // ═══════════════════════════════════════════════════════════════════
        console.log(`[EmbeddedView] Fetching all items via embedded folder view...`);

        while (folderQueue.length > 0 && folderCount < MAX_FOLDERS) {
          const folder = folderQueue.shift()!;
          if (processedFolders.has(folder.id)) continue;
          processedFolders.add(folder.id);
          folderCount++;

          let embeddedSuccess = false;
          try {
            const before = fileMap.size;
            await fetchEmbeddedFolderView(folder.id, folder.name, fileMap, folderQueue, processedFolders);
            embeddedSuccess = fileMap.size > before || fileMap.size > 0;
            console.log(`[EmbeddedView] Folder "${folder.name}": ${fileMap.size - before} new items (total: ${fileMap.size})`);
          } catch (err: any) {
            console.warn(`[EmbeddedView] Failed for folder ${folder.id}: ${err.message}`);
          }

          // ═════════════════════════════════════════════════════════════════
          // STRATEGY 3 — Puppeteer + [data-id] (fallback if embedded fails)
          // ═════════════════════════════════════════════════════════════════
          if (!embeddedSuccess) {
            console.log(`[Puppeteer] Embedded view failed, launching browser for folder ${folder.id}...`);
            try {
              const puppeteer = (await import('puppeteer')).default;
              const browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1920,1080'],
              });

              const page = await browser.newPage();
              await page.setViewport({ width: 1920, height: 1080 });

              await page.setRequestInterception(true);
              page.on('request', (request) => {
                if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) request.abort();
                else request.continue();
              });

              await page.goto(
                `https://drive.google.com/drive/folders/${folder.id}`,
                { waitUntil: 'networkidle2', timeout: 60000 }
              );

              const sessionIds = new Set<string>();
              const collectIds = async () => {
                const ids: (string | null)[] = await page.$$eval('[data-id]', els => els.map(el => el.getAttribute('data-id')));
                for (const id of ids) if (isValidDriveId(id, folder.id)) sessionIds.add(id!);
              };

              await collectIds();
              await page.mouse.click(640, 450);
              let prev = sessionIds.size, stale = 0;

              for (let i = 0; i < 300 && stale < 10; i++) {
                await page.evaluate(() => { window.scrollBy(0, 800); });
                await new Promise(r => setTimeout(r, 600));
                if (i % 2 === 0) {
                  await collectIds();
                  if (sessionIds.size === prev) stale++;
                  else { stale = 0; prev = sessionIds.size; }
                }
              }
              await collectIds();
              await browser.close();

              for (const id of sessionIds) {
                if (!fileMap.has(id)) fileMap.set(id, { isVideo: false, timestamp: Date.now(), folderName: folder.name });
              }
              console.log(`[Puppeteer] Found ${sessionIds.size} IDs in folder ${folder.id}.`);

            } catch (puppeteerErr: any) {
              console.error(`[Puppeteer] Failed: ${puppeteerErr.message}`);

              // ═══════════════════════════════════════════════════════════
              // STRATEGY 4 — Static HTTP scrape (last resort)
              // ═══════════════════════════════════════════════════════════
              try {
                const { data: html } = await axios.get(
                  `https://drive.google.com/drive/folders/${folder.id}`,
                  { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
                ) as { data: string };
                for (const m of html.matchAll(/data-id="([a-zA-Z0-9_-]{25,45})"/g)) {
                  if (isValidDriveId(m[1], folder.id) && !fileMap.has(m[1])) {
                    fileMap.set(m[1], { isVideo: false, timestamp: Date.now(), folderName: folder.name });
                  }
                }
              } catch (_) { }
            }
          }
        }
      }

      const baseUrl = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
      const files = Array.from(fileMap.entries()).map(([id, meta]) => ({
        id,
        // Proxy these for the frontend to avoid blank/CORS issues
        url: `/api/proxy-image?id=${id}&original=true`,
        thumb: `/api/proxy-image?id=${id}`,
        downloadUrl: `/api/download?id=${id}`,
        name: `moment_${id}`,
        isVideo: meta.isVideo,
        timestamp: meta.timestamp,
        folderName: meta.folderName,
      }));

      console.log(`\n🎯 TOTAL: ${files.length} items from ${folderCount} folder(s).\n`);
      res.json({ files });

    } catch (error: any) {
      console.error('[Drive] Fatal error:', error.message);
      res.status(500).json({ error: 'Failed to fetch folder contents', details: error.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/verify-face
  // USES GEMINI 1.5 PRO for "High Analysis" verification
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/verify-face', async (req, res) => {
    let { targetUrl, referenceBase64s } = req.body;
    const geminiKey = process.env.GEMINI_API_KEY?.trim();

    if (!geminiKey) return res.status(500).json({ error: 'Gemini API key not set' });
    if (!targetUrl || !referenceBase64s || !Array.isArray(referenceBase64s)) return res.status(400).json({ error: 'Missing data' });

    // Ensure targetUrl is absolute for the AI
    if (targetUrl.startsWith('/')) {
      const id = targetUrl.split('id=')[1]?.split('&')[0];
      targetUrl = `https://lh3.googleusercontent.com/d/${id}=s1600`;
    }

    try {
      // 1. Validate and Fetch Target Image with Fallbacks
      const fetchImage = async (url: string): Promise<Buffer> => {
        if (!url || !url.startsWith('http')) throw new Error('Invalid URL format');
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        return Buffer.from(res.data);
      };

      let targetData: Buffer;
      try {
        targetData = await fetchImage(targetUrl);
      } catch (err) {
        // Fallback: Try a simpler drive link if lh3 fails
        console.warn(`[Gemini] Primary link failed, trying fallback for ${targetUrl.split('id=')[1]?.split('=')[0]}`);
        const id = targetUrl.split('d/')[1]?.split('=')[0] || targetUrl.split('id=')[1];
        targetData = await fetchImage(`https://drive.google.com/thumbnail?id=${id}&sz=w800`);
      }

      const targetBase64 = targetData.toString('base64');

      // 2. Prepare the "Identity-Wide" JSON prompt
      const prompt = `
        You are a professional facial recognition assistant.
        INSTRUCTIONS:
        - The "TARGET IMAGE" may contain multiple people or a group. 
        - TASK: Is the person from the "REFERENCE IMAGES" present ANYWHERE in the "TARGET IMAGE"?
        - Scan every individual face in the group carefully.
        - If the person is found in the background, in a group, or partially visible, set "isMatch" to true.
        - Set "isMatch" to true if you are at least 50% confident.
        
        RESPONSE FORMAT (JSON ONLY):
        {
          "isMatch": boolean,
          "confidence": number (0-100),
          "reason": "Identify where the person is in the group"
        }
      `.trim();

      const payload = {
        contents: [{
          parts: [
            { text: prompt },
            ...referenceBase64s.map((b: string) => ({
              inlineData: { mimeType: "image/jpeg", data: b.split(',')[1] || b }
            })),
            {
              inlineData: { mimeType: "image/jpeg", data: targetBase64 }
            },
            { text: "The images above are the REFERENCE IMAGES followed by the one TARGET IMAGE at the end." }
          ]
        }],
        generationConfig: {
          response_mime_type: "application/json"
        }
      };

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${geminiKey}`;

      // --- DEEP SCAN AI CALL WITH RETRY LOGIC ---
      const callGemini = async (retryCount = 0): Promise<any> => {
        try {
          const response = await axios.post(geminiUrl, payload, { timeout: 35000 }); // Deep scan timeout
          const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

          // Use a more robust JSON cleaner to handle any markdown characters
          const cleaned = text.replace(/```json|```/g, '').trim();
          return JSON.parse(cleaned);
        } catch (err: any) {
          if ((err.response?.status === 429 || err.response?.status >= 500) && retryCount < 3) {
            console.warn(`[Gemini] Busy... retrying in ${retryCount + 1}s`);
            await new Promise(r => setTimeout(r, (retryCount + 1) * 1000));
            return callGemini(retryCount + 1);
          }
          return { isMatch: false, confidence: 0 }; // Safe fallback
        }
      };

      const result = await callGemini();
      // Expert Precision Gate (70%)
      const isMatch = !!result.isMatch && (result.confidence >= 70);

      const fileId = targetUrl.split('d/')[1]?.split('=')[0] || targetUrl.split('id=')[1]?.split('&')[0];
      console.log(`[High Analysis] ID: ${fileId} | Result: ${isMatch ? '✅ MATCH' : '❌ REJECTED'} (${result.confidence}%) | Reason: ${result.reason}`);

      res.json({ isMatch, confidence: result.confidence, reason: result.reason });

    } catch (error: any) {
      console.error('[Gemini Error]:', error.message);
      res.status(500).json({ error: 'AI Verification failed' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/proxy-image?id=<id>&original=<bool>
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/proxy-image', async (req, res) => {
    const id = req.query.id as string;
    const original = req.query.original === 'true';
    if (!id) return res.status(400).send('Missing id');

    const urls = original
      ? [`https://drive.google.com/uc?export=view&id=${id}`, `https://lh3.googleusercontent.com/d/${id}=s1600`]
      : [`https://lh3.googleusercontent.com/d/${id}=w800`, `https://drive.google.com/thumbnail?id=${id}&sz=w800`, `https://drive.google.com/uc?export=view&id=${id}`];

    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          responseType: 'stream',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Referer': 'https://drive.google.com/',
          },
          timeout: 20000,
          maxRedirects: 5,
          validateStatus: (s) => s === 200,
        });
        res.set('Content-Type', String(response.headers['content-type'] || 'image/jpeg'));
        res.set('Cache-Control', 'public, max-age=86400');
        response.data.pipe(res);
        return;
      } catch (_) { }
    }
    res.status(502).send('Could not fetch image from Google Drive');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/download?id=<id>
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/download', async (req, res) => {
    const id = req.query.id as string;
    if (!id) return res.status(400).send('Missing id');
    try {
      const response = await axios.get(`https://drive.google.com/uc?export=download&id=${id}`, {
        responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        maxRedirects: 5,
      });
      const ct = String(response.headers['content-type'] || 'application/octet-stream');
      res.set('Content-Type', ct);
      res.set('Content-Disposition', `attachment; filename="cipla_${id}.${ct.includes('video') ? 'mp4' : 'jpg'}"`);
      response.data.pipe(res);
    } catch (error: any) {
      console.error('Download error:', error.message);
      res.status(500).send('Download failed');
    }
  });

  // ── Dev: Vite middleware | Prod: static dist ─────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, _res) => _res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server: http://localhost:${PORT}`);
    console.log(process.env.GOOGLE_DRIVE_API_KEY?.trim()
      ? '✅ Drive API key active — unlimited fetch.'
      : '📂 Using Embedded Folder View — fetches all public items without API key.');
    console.log('');
  });
}

startServer();

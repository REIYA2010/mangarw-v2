const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const app = express();

// ==========================================
// 1. Webプロキシ (Ultraviolet等) の処理
// ==========================================
const PROXY_DIR = path.join(__dirname, 'proxy'); 
const PROXY_ENDPOINTS = [
  'prxy', 'baremux', 'epoxy', 'libcurl', 'register-sw.mjs', 'uv'
];

app.get('/proxy', (req, res) => res.redirect('/proxy/'));
app.use('/proxy', express.static(PROXY_DIR));

app.use((req, res, next) => {
    if (res.headersSent) return next();
    
    const fileName = req.path.replace(/^\//, '');
    if (PROXY_ENDPOINTS.includes(fileName)) {
        const targetPath = path.join(PROXY_DIR, fileName);
        if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isFile()) {
            return res.sendFile(targetPath);
        }
    }
    next();
});

// ==========================================
// 2. 漫画プロキシからの保護（干渉防止壁）
// ==========================================
const UV_DYNAMIC_PATHS = [
    '/proxy', '/prxy', '/baremux', '/epoxy', '/libcurl', 
    '/register-sw.mjs', '/uv', '/~uv', '/bare', 
    '/_img_/'
];

app.use((req, res, next) => {
    if (UV_DYNAMIC_PATHS.some(p => req.path.startsWith(p))) {
        if (req.path.startsWith('/_img_/')) return next(); 
        return res.status(404).end();
    }
    next();
});

// ==========================================
// 3. 外部CDNを使った超圧縮・画像プロキシ
// ==========================================
const proxyAgent = new https.Agent({ keepAlive: true, maxSockets: 512, timeout: 60000 });

app.get('/_img_/', async (req, res) => {
    const imgUrl = req.query.url;
    if (!imgUrl) return res.status(400).end();

    const cdnUrl = `https://wsrv.nl/?url=${encodeURIComponent(imgUrl)}&w=720&output=webp&q=40`;

    try {
        const imgRes = await fetch(cdnUrl, {
            headers: { 'User-Agent': req.get('user-agent') || 'Mozilla/5.0' },
            agent: proxyAgent
        });

        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=31536000, immutable');

        if (!imgRes.ok) {
            console.log(`[CDN Miss] Fallback to direct fetch: ${imgUrl}`);
            const fallbackRes = await fetch(imgUrl, {
                headers: { 'Referer': 'https://mangarw.com/', 'User-Agent': 'Mozilla/5.0' },
                agent: proxyAgent
            });
            res.set('Content-Type', fallbackRes.headers.get('content-type'));
            return fallbackRes.body.pipe(res);
        }

        res.set('Content-Type', 'image/webp'); 
        imgRes.body.pipe(res);
        imgRes.body.on('error', () => {
            if (!res.headersSent) res.end();
        });
    } catch (e) {
        if (!res.headersSent) res.status(502).end();
    }
});

// ==========================================
// 4. 漫画プロキシ (MangaRaw 本体処理)
// ==========================================
const TARGET_HOST = "mangarw.com";
const TARGET_BASE = `https://${TARGET_HOST}`;

app.use(express.raw({ type: '*/*', limit: '50mb' }));

const INJECT_CODE = `
<style>
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [class*="ad-"], #toast,
  [style*="z-index: 2147483647"], [style*="z-index: 9999"], 
  a[href*="adexchangerapid"], a[href*="university"] { display: none !important; pointer-events: none !important; }
  #load-more-chapters, .load-more, .read-more { display: block !important; visibility: visible !important; opacity: 1 !important; background: #3b82f6 !important; color: white !important; border-radius: 8px; padding: 15px !important; text-align: center; cursor: pointer; }
</style>
<script>
  (function() {
    window.open = () => null;

    const processImages = () => {
      document.querySelectorAll('img').forEach(img => {
        const src = img.dataset.src || img.getAttribute('src');
        if (src && !src.startsWith('data:') && !src.includes('/_img_/?url=')) {
          const absUrl = src.startsWith('http') ? src : window.location.origin + (src.startsWith('/') ? src : '/' + src);
          const proxyUrl = '/_img_/?url=' + encodeURIComponent(absUrl);
          img.setAttribute('src', proxyUrl);
          img.setAttribute('data-src', proxyUrl);
          img.removeAttribute('loading'); 
        }
      });
    };

    const nukeOverlays = () => {
      document.querySelectorAll('div, a, section, ins').forEach(el => {
        const s = window.getComputedStyle(el);
        if (parseInt(s.zIndex) > 1000 && parseFloat(s.opacity) < 0.1 && !el.innerText.trim()) el.remove();
      });
    };
    setInterval(nukeOverlays, 1000);

    const initAll = () => {
      processImages();
      const obs = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const imgs = Array.from(document.querySelectorAll('img'));
            const idx = imgs.indexOf(entry.target);
            for(let i=1; i<=5; i++) {
              if (imgs[idx+i] && imgs[idx+i].dataset.src && imgs[idx+i].src !== imgs[idx+i].dataset.src) {
                imgs[idx+i].src = imgs[idx+i].dataset.src;
              }
            }
          }
        });
      }, { rootMargin: '1500px 0px' });
      document.querySelectorAll('img').forEach(i => { if(i.dataset.src) obs.observe(i); });
      new MutationObserver(processImages).observe(document.body, { childList: true, subtree: true });
    };
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', initAll) : initAll();
    
    window.addEventListener('click', function(e) {
      const target = e.target.closest('a');
      if (target && target.href && (target.href.includes('adex') || target.href.includes('university'))) {
        e.preventDefault(); e.stopImmediatePropagation(); return false;
      }
    }, true); 
  })();
</script>
`;

// ==========================================
// ⭐ 圧縮展開関数
// ==========================================
function decompressBuffer(buffer, encoding) {
    if (!encoding || encoding === 'identity') return buffer;
    
    if (encoding.includes('zstd')) {
        console.log(`[Decompress] zstd detected, returning raw buffer (${buffer.length} bytes)`);
        return buffer;
    }
    
    try {
        if (encoding.includes('gzip')) {
            return zlib.gunzipSync(buffer);
        } else if (encoding.includes('br')) {
            return zlib.brotliDecompressSync(buffer);
        } else if (encoding.includes('deflate')) {
            return zlib.inflateSync(buffer);
        }
    } catch (e) {
        console.log(`[Decompress Error] ${e.message}`);
    }
    return buffer;
}

app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    // ⭐ あなたの専用プロキシURLを使用
    const targetUrl = `https://web-production-528aa.up.railway.app/${TARGET_BASE}${req.url}`;
    const currentHost = req.get('host');

    const h = { ...req.headers };
    delete h.host; delete h.connection; delete h['content-length']; 
    h['Origin'] = TARGET_BASE;
    h['Referer'] = TARGET_BASE + '/';
    h['Accept-Encoding'] = 'identity';

    console.log(`[Proxy] Requesting: ${targetUrl}`);

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: h,
            agent: proxyAgent,
            redirect: 'manual',
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined,
            timeout: 30000,
            compress: false
        });

        console.log(`[Proxy] Response status: ${response.status}`);

        let resHeaders = {};
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options', 'strict-transport-security'].includes(key)) {
                resHeaders[key] = v;
            }
        });

        if (resHeaders['location']) {
            resHeaders['location'] = resHeaders['location'].replace(new RegExp(`https:\/\/[a-z0-9.-]*${TARGET_HOST}`, 'gi'), `https://${currentHost}`);
        }

        if (resHeaders['set-cookie']) {
            let cookies = response.headers.raw()['set-cookie'];
            resHeaders['set-cookie'] = cookies.map(cookie => {
                let clean = cookie.replace(new RegExp(`domain=\\.?[a-z0-9.-]*${TARGET_HOST};?`, 'gi'), "");
                clean = clean.replace(/SameSite=(Lax|Strict)/gi, "SameSite=None");
                if (!clean.includes("Secure")) clean += "; Secure";
                return clean;
            });
        }

        const contentType = response.headers.get("content-type") || "";
        const contentEncoding = response.headers.get("content-encoding") || "";

        // ==========================================
        // ⭐ 画像・バイナリ処理
        // ==========================================
        const isBinary = 
            contentType.startsWith("image/") ||
            contentType.startsWith("video/") ||
            contentType.startsWith("audio/") ||
            contentType.startsWith("font/") ||
            contentType.startsWith("application/octet-stream") ||
            contentType.includes("pdf") ||
            contentType.includes("zip");

        if (isBinary) {
            res.set(resHeaders);
            res.status(response.status);
            response.body.pipe(res);
            return;
        }

        // ==========================================
        // ⭐ HTML処理
        // ==========================================
        if (contentType.includes("text/html")) {
            const buffer = await response.buffer();
            console.log(`[HTML] Content-Encoding: ${contentEncoding}, Buffer size: ${buffer.length}`);
            
            let text;
            if (contentEncoding && contentEncoding !== 'identity') {
                const decompressed = decompressBuffer(buffer, contentEncoding);
                text = decompressed.toString('utf-8');
            } else {
                text = buffer.toString('utf-8');
            }
            
            console.log(`[HTML] Decompressed size: ${text.length}`);
            console.log(`[HTML] First 200 chars: ${text.substring(0, 200)}`);
            
            // HTML加工処理
            text = text.replace(/onclick=".*?"/gi, 'data-removed-click=""');
            const badDomains = ['universityshocksooner.com', 'adexchangerapid.com', 'gomuraw.js', 'platform.pubadx.one'];
            badDomains.forEach(d => {
                const re = new RegExp('<script[^>]*' + d.replace('.', '\\.') + '[^>]*><\\/script>', 'gi');
                text = text.replace(re, "");
                text = text.split(d).join("localhost");
            });
            text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");

            text = text.replace(new RegExp(`https:\/\/[a-z0-9.-]*${TARGET_HOST}`, 'gi'), `https://${currentHost}`);
            text = text.replace(new RegExp(`\/\/${TARGET_HOST}`, 'g'), `//${currentHost}`);

            text = text.replace('<head>', '<head>' + INJECT_CODE);
            
            res.set(resHeaders);
            res.set("Content-Type", "text/html; charset=utf-8");
            res.set("Content-Encoding", "identity");
            res.removeHeader('content-length');
            
            return res.status(response.status).send(text);
        }

        // ==========================================
        // CSS処理
        // ==========================================
        if (contentType.includes("css")) {
            const buffer = await response.buffer();
            let cssText;
            if (contentEncoding && contentEncoding !== 'identity') {
                const decompressed = decompressBuffer(buffer, contentEncoding);
                cssText = decompressed.toString('utf-8');
            } else {
                cssText = buffer.toString('utf-8');
            }
            cssText = cssText.replace(/url\(['"]?\//g, `url("https://${currentHost}/`);
            res.set(resHeaders);
            res.set("Content-Encoding", "identity");
            res.removeHeader('content-length');
            return res.status(response.status).send(cssText);
        }

        // ==========================================
        // JavaScript / JSON 処理
        // ==========================================
        if (contentType.includes("javascript") || contentType.includes("json")) {
            const buffer = await response.buffer();
            let text;
            if (contentEncoding && contentEncoding !== 'identity') {
                const decompressed = decompressBuffer(buffer, contentEncoding);
                text = decompressed.toString('utf-8');
            } else {
                text = buffer.toString('utf-8');
            }
            res.set(resHeaders);
            res.set("Content-Encoding", "identity");
            res.removeHeader('content-length');
            return res.status(response.status).send(text);
        }

        // ==========================================
        // その他
        // ==========================================
        res.set(resHeaders);
        res.status(response.status);
        response.body.pipe(res);

    } catch (error) {
        console.error(`[Proxy Error] ${error.message}`);
        if (!res.headersSent) res.status(502).send("Server Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Super Compressed Manga Engine Online on port ${PORT}`));

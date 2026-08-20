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
// 3. 画像プロキシ
// ==========================================
const proxyAgent = new https.Agent({ keepAlive: true, maxSockets: 512, timeout: 60000 });

app.get('/_img_', (req, res) => {
    const query = req.query.url ? `?url=${encodeURIComponent(req.query.url)}` : '';
    res.redirect(`/_img_/${query}`);
});

app.get('/_img_/', async (req, res) => {
    const imgUrl = req.query.url;
    if (!imgUrl) {
        console.log('[Image] No URL provided');
        return res.status(400).send('Missing url parameter');
    }

    console.log(`[Image] Requesting: ${imgUrl}`);

    let decodedUrl = imgUrl;
    try {
        decodedUrl = decodeURIComponent(imgUrl);
        console.log(`[Image] Decoded URL: ${decodedUrl}`);
    } catch (e) {
        console.log(`[Image] Decode failed, using original: ${imgUrl}`);
    }

    let finalUrl = decodedUrl;
    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
        if (finalUrl.startsWith('//')) {
            finalUrl = 'https:' + finalUrl;
        } else if (finalUrl.startsWith('/')) {
            finalUrl = 'https://mangarw.com' + finalUrl;
        } else {
            finalUrl = 'https://mangarw.com/' + finalUrl;
        }
    }
    
    finalUrl = finalUrl.replace(/ /g, '%20');
    console.log(`[Image] Final URL: ${finalUrl}`);

    const fetchOptions = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
            'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
            'Accept-Encoding': 'identity',
            'Referer': 'https://mangarw.com/',
            'Origin': 'https://mangarw.com/'
        },
        agent: proxyAgent,
        timeout: 30000,
        compress: false,
        redirect: 'follow'
    };

    try {
        const imgRes = await fetch(finalUrl, fetchOptions);

        const contentType = imgRes.headers.get('content-type') || '';
        console.log(`[Image] Response status: ${imgRes.status}`);
        console.log(`[Image] Response content-type: ${contentType}`);
        
        if (!contentType.startsWith('image/')) {
            console.log(`[Image] Warning: Not an image! Content-Type: ${contentType}`);
            const text = await imgRes.text();
            console.log(`[Image] Response body (first 200 chars): ${text.substring(0, 200)}`);
            return res.status(502).send(`Not an image: ${contentType}`);
        }

        if (!imgRes.ok) {
            console.log(`[Image] Failed: ${finalUrl} -> ${imgRes.status}`);
            return res.status(502).send(`Image load failed: ${imgRes.status}`);
        }

        console.log(`[Image] Success: ${finalUrl} -> ${contentType}`);
        
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400, immutable');
        res.set('Content-Type', contentType);
        res.removeHeader('content-length');
        
        imgRes.body.pipe(res);
        imgRes.body.on('error', (err) => {
            console.error(`[Image] Pipe error: ${err.message}`);
            if (!res.headersSent) res.status(502).end();
        });

    } catch (e) {
        console.error(`[Image] Error: ${e.message}`);
        if (!res.headersSent) res.status(502).send(`Image proxy error: ${e.message}`);
    }
});

// ==========================================
// 4. 漫画プロキシ (MangaRaw 本体処理)
// ==========================================
const TARGET_HOST = "mangarw.com";
const TARGET_BASE = `https://${TARGET_HOST}`;

app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ==========================================
// ⭐ INJECT_CODE（修正版）
// ==========================================
const INJECT_CODE = `
<style>
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [class*="ad-"], #toast,
  [style*="z-index: 2147483647"], [style*="z-index: 9999"], 
  a[href*="adexchangerapid"], a[href*="university"] { display: none !important; pointer-events: none !important; }
  #load-more-chapters, .load-more, .read-more { display: block !important; visibility: visible !important; opacity: 1 !important; background: #3b82f6 !important; color: white !important; border-radius: 8px; padding: 15px !important; text-align: center; cursor: pointer; }
</style>

<script>
  console.log('[DEBUG] Script loaded');

  function fixImages() {
    console.log('[DEBUG] fixImages called');
    var images = document.querySelectorAll('img');
    console.log('[DEBUG] Found ' + images.length + ' images');
    
    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      var src = img.dataset.src || img.getAttribute('src');
      console.log('[DEBUG] Image ' + i + ': src =', src);
      
      if (!src) continue;
      if (src.indexOf('data:') === 0) {
        if (img.dataset.src && img.dataset.src.indexOf('data:') !== 0) {
          src = img.dataset.src;
          console.log('[DEBUG] Image ' + i + ': using data-src =', src);
        } else {
          continue;
        }
      }
      if (src.indexOf('/_img_/') !== -1) continue;
      if (src.indexOf('data:') === 0) continue;
      
      var proxyUrl = '/_img_/?url=' + encodeURIComponent(src);
      console.log('[DEBUG] Image ' + i + ': proxyUrl =', proxyUrl);
      
      img.setAttribute('src', proxyUrl);
      if (img.dataset.src) {
        img.dataset.src = proxyUrl;
      }
      img.loading = 'eager';
      img.removeAttribute('loading');
    }
  }

  fixImages();

  setTimeout(fixImages, 100);
  setTimeout(fixImages, 300);
  setTimeout(fixImages, 500);
  setTimeout(fixImages, 1000);
  setTimeout(fixImages, 2000);
  setTimeout(fixImages, 3000);
  setTimeout(fixImages, 5000);

  document.addEventListener('DOMContentLoaded', function() {
    console.log('[DEBUG] DOMContentLoaded');
    fixImages();
  });

  window.addEventListener('load', function() {
    console.log('[DEBUG] window.load');
    fixImages();
  });

  var observer = new MutationObserver(function() {
    fixImages();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  setInterval(function() {
    var images = document.querySelectorAll('img');
    for (var i = 0; i < images.length; i++) {
      var src = images[i].getAttribute('src');
      if (src && src.indexOf('https://') === 0 && src.indexOf('/_img_/') === -1) {
        console.log('[DEBUG] Interval: fixing images');
        fixImages();
        break;
      }
    }
  }, 2000);

  console.log('[DEBUG] Script initialized');
</script>
`;

// ==========================================
// ⭐ 圧縮展開関数
// ==========================================
function decompressBuffer(buffer, encoding) {
    if (!encoding || encoding === 'identity') return buffer;
    
    if (encoding.includes('zstd')) {
        console.log(`[Decompress] zstd detected, passing through to browser`);
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

    if (req.url.includes('favicon')) {
        console.log('[Favicon] Returning dummy response');
        res.set('Content-Type', 'image/png');
        return res.status(200).send(Buffer.from(''));
    }

    if (req.url.includes('/view-count')) {
        const targetUrl = `https://mangarw.com${req.url}`;
        console.log(`[Direct] Proxying view-count: ${targetUrl}`);
        
        try {
            const response = await fetch(targetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Referer': 'https://mangarw.com/',
                    'Origin': 'https://mangarw.com/'
                },
                timeout: 10000
            });
            
            const data = await response.text();
            res.set('Content-Type', 'application/json');
            res.set('Access-Control-Allow-Origin', '*');
            return res.status(response.status).send(data);
        } catch (e) {
            console.error(`[view-count Error] ${e.message}`);
            return res.status(502).json({ error: 'view-count proxy error' });
        }
    }

    const targetUrl = TARGET_BASE + req.url;
    const currentHost = req.get('host');

    const h = { ...req.headers };
    delete h.host; delete h.connection; delete h['content-length']; 
    h['Origin'] = TARGET_BASE;
    h['Referer'] = TARGET_BASE + '/';
    h['Accept-Encoding'] = 'identity';

    console.log(`[Proxy] Direct request to: ${targetUrl}`);

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

        if (contentType.includes("text/html")) {
            const buffer = await response.buffer();
            console.log(`[HTML] Content-Encoding: ${contentEncoding}, Buffer size: ${buffer.length}`);
            
            if (contentEncoding.includes('zstd')) {
                console.log(`[HTML] zstd detected, passing through to browser`);
                res.set(resHeaders);
                res.set("Content-Type", "text/html; charset=utf-8");
                res.set("Content-Encoding", "zstd");
                return res.status(response.status).send(buffer);
            }
            
            const decompressed = decompressBuffer(buffer, contentEncoding);
            let text = decompressed.toString('utf-8');
            
            console.log(`[HTML] Decompressed size: ${text.length}`);
            console.log(`[HTML] First 200 chars: ${text.substring(0, 200)}`);
            
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

        if (contentType.includes("css")) {
            const buffer = await response.buffer();
            const decompressed = decompressBuffer(buffer, contentEncoding);
            let cssText = decompressed.toString('utf-8');
            cssText = cssText.replace(/url\(['"]?\//g, `url("https://${currentHost}/`);
            res.set(resHeaders);
            res.set("Content-Encoding", "identity");
            res.removeHeader('content-length');
            return res.status(response.status).send(cssText);
        }

        if (contentType.includes("javascript") || contentType.includes("json")) {
            const buffer = await response.buffer();
            const decompressed = decompressBuffer(buffer, contentEncoding);
            let text = decompressed.toString('utf-8');
            res.set(resHeaders);
            res.set("Content-Encoding", "identity");
            res.removeHeader('content-length');
            return res.status(response.status).send(text);
        }

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

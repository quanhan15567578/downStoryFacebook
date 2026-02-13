const { Telegraf } = require('telegraf');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const archiver = require('archiver');
const { DOMParser } = require('@xmldom/xmldom');
const { LowSync } = require('lowdb');
const { JSONFileSync } = require('lowdb/node');
const express = require('express');

const adapter = new JSONFileSync('database.json');
const defaultData = { profiles: [], downloaded: {}, cookies: null };
const db = new LowSync(adapter, defaultData);

db.read();

if (!db.data) {
  db.data = { profiles: [], downloaded: {}, cookies: null };
  db.write();
}

const execPromise = util.promisify(exec);

// Token từ env (bắt buộc!)
const TELEGRAM_TOKEN = '8578868890:AAFs1-9_CDQYF81GRVeAJcZI5p_lFuViInc';

const ADMIN_CHAT_ID = 452130340;

const bot = new Telegraf(TELEGRAM_TOKEN);

// ──────────────────────────────────────── Cookie Management ────────────────────────────────────────
function getCookieString() {
  db.read();
  return db.data.cookies || null;
}

function saveCookies(cookieString) {
  db.read();
  db.data.cookies = cookieString;
  db.write();
  console.log('✅ Đã lưu cookies vào database');
}

// ──────────────────────────────────────── Helper: Normalize URL ────────────────────────────────────────
function normalizeProfileUrl(url) {
  let normalized = url.trim();
  
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = 'https://' + normalized;
  }
  
  normalized = normalized.replace('https://facebook.com/', 'https://www.facebook.com/');
  normalized = normalized.replace('http://facebook.com/', 'https://www.facebook.com/');
  
  return normalized;
}

// ──────────────────────────────────────── CRITICAL: Browser-like Headers ────────────────────────────────────────
function getBrowserHeaders(cookie, referer = null) {
  // Dựa trên extension headers - giả lập Chrome browser
  const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.facebook.com/',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none'
};

  if (cookie) {
    headers['cookie'] = cookie;
  }

  if (referer) {
    headers['referer'] = referer;
    headers['sec-fetch-site'] = 'same-origin';
  }

  return headers;
}

// ──────────────────────────────────────── Enhanced Fetch với Browser Simulation ────────────────────────────────────────
async function fetchWithHeaders(url, options = {}) {
  const cookie = getCookieString();
  
  const config = {
    method: options.method || 'GET',
    url: url,
    headers: getBrowserHeaders(cookie, options.referer),
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: (status) => status < 500, // Accept redirects
    ...options
  };

  // CRITICAL: Support zstd compression như browser thật
  // Node.js axios mặc định chỉ support gzip, deflate, br
  // Nếu server trả về zstd, cần decompress manually
  // Tuy nhiên axios sẽ tự động handle gzip, deflate, br
  
  try {
    const response = await axios(config);
    
    // Log để debug
    console.log(`📡 Fetch ${url.substring(0, 80)}... → Status: ${response.status}`);
    
    return response;
  } catch (error) {
    console.error(`❌ Fetch error for ${url}:`, error.message);
    throw error;
  }
}

async function fetchProfileHtml(profileUrl) {
  const response = await fetchWithHeaders(profileUrl);
  
  if (response.status === 302 || response.status === 301) {
    console.log('⚠️ Redirect detected - cookie có thể cần refresh');
  }
  
  return response.data;
}

async function fetchStoryJson(storyUrl) {
  // Khi fetch story JSON, cần set referer là profile page
  const profileUrl = storyUrl.split('/stories/')[0];
  
  const response = await fetchWithHeaders(storyUrl, {
    referer: profileUrl
  });
  
  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status} khi fetch story`);
  }

  const html = response.data;
  
  // Extract JSON từ HTML
  const scriptMatch = html.match(/<script[^>]*>requireLazy\(\["CometSuspenseFalcoEvent"\][^<]*<\/script>/);
  if (!scriptMatch) {
    throw new Error('Không tìm thấy script data trong story page');
  }

  const scriptContent = scriptMatch[0];
  const jsonMatch = scriptContent.match(/\{.*"require":\[\[.*?\]\].*\}/s);
  
  if (!jsonMatch) {
    throw new Error('Không parse được JSON từ script');
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new Error('JSON parse failed: ' + err.message);
  }
}

async function downloadFile(url, targetPath) {
  try {
    const cookie = getCookieString();
    
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'accept': '*/*',
        'accept-encoding': 'gzip, deflate, br',
        'referer': 'https://www.facebook.com/',
        'cookie': cookie || '',
        'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'video',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      },
      timeout: 120000, // 2 minutes cho video lớn
      maxRedirects: 5
    });

    const writer = (await fs.open(targetPath, 'w')).createWriteStream();
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(true));
      writer.on('error', reject);
    });
  } catch (err) {
    console.error(`Download failed for ${url}:`, err.message);
    return false;
  }
}

// ──────────────────────────────────────── Middleware: Chỉ admin dùng lệnh ────────────────────────────────────────
bot.use(async (ctx, next) => {
  if (ctx.from.id !== ADMIN_CHAT_ID) {
    if (['/start', '/help'].includes(ctx.message?.text)) {
      return next();
    }
    return ctx.reply('Bạn không có quyền sử dụng bot này.');
  }
  await next();
});

// ──────────────────────────────────────── Lệnh điều khiển ────────────────────────────────────────
bot.command('start', (ctx) => ctx.reply(`Facebook Story Downloader Bot

Các lệnh:
/startdl → chạy tất cả profiles
/list → xem danh sách profiles
/cookie → hướng dẫn lấy cookie
/showcookie → hiển thị cookie đang dùng
/test → test cookie hiện tại

DOWN <url> → tải 1 story
ADD <url> → thêm profile
REMOVE <url> → xóa profile
SETCOOKIE <cookie> → set cookie mới

Ví dụ:
DOWN https://facebook.com/stories/123
ADD facebook.com/username
SETCOOKIE datr=xxx;sb=yyy;c_user=zzz;xs=aaa...`));

bot.command('help', (ctx) => ctx.reply('Gửi /start để xem hướng dẫn đầy đủ'));

bot.command('test', async (ctx) => {
  const cookie = getCookieString();
  if (!cookie) {
    return ctx.reply('⚠️ Chưa có cookie! Dùng lệnh /cookie để xem hướng dẫn.');
  }
  
  ctx.reply('🔍 Đang test cookie...');
  
  try {
    const testUrl = 'https://www.facebook.com/';
    const response = await fetchWithHeaders(testUrl);
    
    if (response.status === 200 && response.data.includes('Facebook')) {
      ctx.reply('✅ Cookie hoạt động tốt!\n\nBạn có thể dùng bot bình thường.');
    } else {
      ctx.reply('⚠️ Cookie có vẻ không ổn. Hãy thử lấy cookie mới.');
    }
  } catch (err) {
    ctx.reply(`❌ Lỗi khi test cookie:\n${err.message}\n\nHãy lấy cookie mới và thử lại.`);
  }
});

bot.command('showcookie', (ctx) => {
  const cookie = getCookieString();
  if (!cookie) {
    return ctx.reply('⚠️ Chưa có cookie nào được set.\n\nDùng lệnh:\nSETCOOKIE <cookie_string>');
  }
  
  const preview = cookie.length > 100 ? cookie.substring(0, 100) + '...' : cookie;
  ctx.reply(`🍪 Cookie hiện tại:\n${preview}\n\n📊 Độ dài: ${cookie.length} ký tự`);
});

bot.command('cookie', (ctx) => {
  ctx.reply(`📖 HƯỚNG DẪN LẤY COOKIE FACEBOOK:

1. Mở Facebook trong Chrome/Edge
2. Nhấn F12 để mở DevTools
3. Vào tab "Application" → "Cookies" → "https://www.facebook.com"
4. Copy các giá trị sau (QUAN TRỌNG):
   • datr (bắt buộc)
   • sb (bắt buộc)
   • c_user (bắt buộc)
   • xs (bắt buộc)
   • fr (tùy chọn)
   • presence (tùy chọn)
   • wd (tùy chọn)

5. Ghép thành string:
datr=VALUE1; sb=VALUE2; c_user=VALUE3; xs=VALUE4; fr=VALUE5

6. Gửi cho bot:
SETCOOKIE datr=xxx; sb=yyy; c_user=zzz; xs=aaa...

⚠️ QUAN TRỌNG:
• Phải có đủ 4 cookie: datr, sb, c_user, xs
• Cookie có thể hết hạn sau vài tuần
• KHÔNG chia sẻ cookie với người khác
• Copy CHÍNH XÁC từ DevTools (bao gồm cả dấu chấm phẩy)`);
});

bot.hears(/^SETCOOKIE\s+(.+)$/is, async (ctx) => {
  const cookieString = ctx.match[1].trim();
  
  // Validate cookie
  const required = ['datr', 'sb', 'c_user', 'xs'];
  const missing = required.filter(key => !cookieString.includes(key));
  
  if (missing.length > 0) {
    return ctx.reply(`❌ Cookie thiếu: ${missing.join(', ')}\n\nCần đủ 4 cookie:\ndatr, sb, c_user, xs\n\nVí dụ:\nSETCOOKIE datr=xxx; sb=yyy; c_user=zzz; xs=aaa...`);
  }
  
  saveCookies(cookieString);
  ctx.reply('✅ Đã lưu cookie thành công!\n\nDùng /test để kiểm tra cookie\nHoặc thử download:\nDOWN <story_url>');
  
  // Xóa message chứa cookie để bảo mật
  try {
    await ctx.deleteMessage();
  } catch (err) {
    console.log('Cannot delete message');
  }
});

bot.command('startdl', async (ctx) => {
  const cookie = getCookieString();
  if (!cookie) {
    return ctx.reply('⚠️ Chưa có cookie! Dùng lệnh /cookie để xem hướng dẫn.');
  }
  
  ctx.reply('🚀 Bắt đầu kiểm tra và download stories...');
  await processAllProfiles();
  ctx.reply('✅ Hoàn tất kiểm tra hôm nay.');
});

bot.hears(/^DOWN\s+(https?:\/\/.+)$/i, async (ctx) => {
  const url = ctx.match[1].trim();
  const cookie = getCookieString();
  
  if (!cookie) {
    return ctx.reply('⚠️ Chưa có cookie! Dùng lệnh /cookie để xem hướng dẫn.');
  }
  
  ctx.reply(`📥 Đang xử lý story: ${url}`);
  try {
    await processSingleStory(url, ctx);
  } catch (err) {
    ctx.reply(`❌ LỖI: ${err.message}`);
  }
});

bot.hears(/^ADD\s+(.+)$/i, async (ctx) => {
  let url = ctx.match[1].trim();
  url = normalizeProfileUrl(url);

  db.read();
  const profiles = db.data.profiles || [];
  
  if (profiles.includes(url)) {
    return ctx.reply('⚠️ Profile này đã có trong danh sách.');
  }

  db.data.profiles.push(url);
  db.write();
  ctx.reply(`✅ Đã thêm profile: ${url}`);
});

bot.hears(/^REMOVE\s+(.+)$/i, async (ctx) => {
  let input = ctx.match[1].trim();
  let url;

  if (input.startsWith('http')) {
    url = normalizeProfileUrl(input);
  } else {
    url = `https://www.facebook.com/${input.trim()}`;
  }

  db.read();
  const profiles = db.data.profiles || [];
  const normalized = [
    url, 
    url.replace('www.', ''), 
    url.replace('https://www.facebook.com/', 'https://facebook.com/')
  ];

  const newProfiles = profiles.filter(p => !normalized.includes(p));

  if (newProfiles.length === profiles.length) {
    return ctx.reply('❌ Không tìm thấy profile để xoá.');
  }

  db.data.profiles = newProfiles;
  db.write();
  ctx.reply(`✅ Đã xoá: ${url}`);
});

bot.command('list', (ctx) => {
  db.read();
  const profiles = db.data.profiles || [];
  if (!profiles.length) return ctx.reply('📋 Danh sách trống.');
  
  const preview = profiles.slice(0, 20).join('\n');
  const more = profiles.length > 20 ? `\n\n... và ${profiles.length - 20} profile khác` : '';
  ctx.reply(`📋 Danh sách profiles (${profiles.length}):\n\n${preview}${more}`);
});

// ──────────────────────────────────────── Utils ────────────────────────────────────────
async function getTodayKey() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

async function isDownloaded(mediaId, dateKey) {
  db.read();
  const downloaded = db.data.downloaded || {};
  return downloaded[dateKey]?.includes(mediaId) || false;
}

async function markDownloaded(mediaId, dateKey) {
  db.read();
  if (!db.data.downloaded) db.data.downloaded = {};
  if (!db.data.downloaded[dateKey]) db.data.downloaded[dateKey] = [];
  db.data.downloaded[dateKey].push(mediaId);
  db.write();
}

async function cleanOldDownloaded() {
  const today = await getTodayKey();
  db.read();
  const downloaded = db.data.downloaded || {};
  const keys = Object.keys(downloaded);
  
  const toDelete = keys.filter(k => k !== today);
  toDelete.forEach(k => delete downloaded[k]);
  
  db.data.downloaded = downloaded;
  db.write();
  
  if (toDelete.length > 0) {
    console.log(`🧹 Cleaned ${toDelete.length} old download records`);
  }
}

function extractStoryUrlFromProfile(html) {
  const $ = cheerio.load(html);
  
  // Tìm link story trong HTML
  let storyUrl = null;
  
  $('a[href*="/stories/"]').each((i, elem) => {
    const href = $(elem).attr('href');
    if (href && href.includes('/stories/') && !storyUrl) {
      storyUrl = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
    }
  });
  
  return storyUrl;
}

function getUsernameFromStoryData(storyData) {
  let username = 'Unknown';
  
  try {
    storyData.require?.forEach(req => {
      if (req?.[3]?.[0]?.__bbox?.result?.data?.bucket?.owner?.name) {
        username = req[3][0].__bbox.result.data.bucket.owner.name;
      }
    });
  } catch (err) {
    console.log('Could not extract username from story data');
  }
  
  return username;
}

async function downloadFacebookStoryVideo(media, username, folderPath, id) {
  const qualities = [
    { key: 'hd_playback_url', quality: 'HD' },
    { key: 'sd_playback_url', quality: 'SD' },
    { key: 'playable_url', quality: 'Standard' }
  ];

  for (const { key, quality } of qualities) {
    const url = media[key];
    if (!url) continue;

    const filename = `${id} - ${username.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`;
    const targetPath = path.join(folderPath, filename);

    const ok = await downloadFile(url, targetPath);
    if (ok) {
      console.log(`   ✅ Downloaded ${quality} video → ${targetPath}`);
      return targetPath;
    }
  }
  
  return null;
}

async function downloadPhoto(media, username, folderPath, id) {
  const url = media?.image?.uri;
  if (!url) return null;

  let ext = 'jpg';
  try {
    ext = new URL(url).pathname.split('.').pop().split('?')[0] || 'jpg';
  } catch {}

  const filename = `${id} - ${username.replace(/[^a-zA-Z0-9]/g, '_')}.${ext}`;
  const filepath = path.join(folderPath, filename);

  const ok = await downloadFile(url, filepath);
  return ok ? filepath : null;
}

// ──────────────────────────────────────── Zip & Send ────────────────────────────────────────
async function zipAndSend(folderPath, folderName) {
  const zipPath = `${folderPath}.zip`;
  const output = (await fs.open(zipPath, 'w')).createWriteStream();
  const archive = archiver('zip', { zlib: { level: 9 } });

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(folderPath, false);
    archive.finalize();
  });

  await bot.telegram.sendDocument(ADMIN_CHAT_ID, {
    source: zipPath,
    filename: `${folderName}.zip`
  });

  await fs.rm(folderPath, { recursive: true, force: true }).catch(() => {});
  await fs.unlink(zipPath).catch(() => {});
}

// ──────────────────────────────────────── Core Processing ────────────────────────────────────────
async function processProfile(profileUrl) {
  const today = await getTodayKey();
  let username = 'Unknown';

  try {
    const normalizedUrl = normalizeProfileUrl(profileUrl);
    console.log(`📍 Đang xử lý: ${normalizedUrl}`);
    
    const html = await fetchProfileHtml(normalizedUrl);
    const storyUrl = await extractStoryUrlFromProfile(html);
    
    if (!storyUrl) {
      console.log(`   ℹ️  Không có story mới`);
      return;
    }

    console.log(`   📖 Story URL: ${storyUrl}`);
    
    const bucketIdMatch = storyUrl.match(/stories\/(\d+)/);
    if (!bucketIdMatch) return;
    const bucketId = bucketIdMatch[1];

    const storyData = await fetchStoryJson(storyUrl);
    if (!storyData) return;

    username = getUsernameFromStoryData(storyData);

    let bucketData = null;
    storyData.require?.forEach(req => {
      if (req?.[3]?.[0]?.__bbox?.result?.data?.bucket?.id === bucketId) {
        bucketData = req[3][0].__bbox.result.data.bucket;
      }
    });
    if (!bucketData) return;

    const nodes = bucketData.unified_stories_with_notes?.edges || [];
    if (!nodes.length) return;

    const folderName = `${username} - ${today}`;
    const folderPath = path.join(__dirname, 'temp', folderName);
    await fs.mkdir(folderPath, { recursive: true });

    let downloadedFiles = [];

    for (const edge of nodes) {
      const node = edge.node;
      if (node?.story_card_info?.bucket?.camera_post_type === 'ADMINED_ADDITIONAL_PROFILE_STORY') continue;

      const media = node?.attachments?.[0]?.media;
      if (!media?.id) continue;

      const id = media.id;
      if (await isDownloaded(id, today)) continue;

      let filePath = null;

      if (media.__typename === 'Photo') {
        filePath = await downloadPhoto(media, username, folderPath, id);
      } else if (media.__typename === 'Video') {
        filePath = await downloadFacebookStoryVideo(media, username, folderPath, id);
      }

      if (filePath) {
        downloadedFiles.push(filePath);
        await markDownloaded(id, today);
      }
    }

    if (downloadedFiles.length > 0) {
      await zipAndSend(folderPath, folderName);
      console.log(`   ✅ Gửi zip cho ${username} - ${downloadedFiles.length} file`);
    } else {
      await fs.rm(folderPath, { recursive: true, force: true }).catch(() => {});
      console.log(`   ℹ️  Không có file mới để download`);
    }
  } catch (err) {
    console.error(`   ❌ Lỗi: ${err.message}`);
  }
}

async function processAllProfiles() {
  await cleanOldDownloaded();
  db.read();
  const profiles = db.data.profiles || [];
  console.log(`\n🚀 Bắt đầu xử lý ${profiles.length} profiles...`);
  
  for (const url of profiles) {
    await processProfile(url);
    // Delay 3-5s giữa các profile để tránh rate limit
    const delay = 3000 + Math.random() * 2000;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  console.log(`\n✅ Hoàn tất xử lý tất cả profiles\n`);
}

async function processSingleStory(storyUrl, ctx) {
  const today = await getTodayKey();
  let username = 'Unknown_Single';

  try {
    console.log(`📖 Đang xử lý story: ${storyUrl}`);
    
    const storyData = await fetchStoryJson(storyUrl);
    if (!storyData) throw new Error('Không lấy được dữ liệu story - có thể cookie hết hạn hoặc story không tồn tại');

    username = getUsernameFromStoryData(storyData);
    console.log(`   👤 Username: ${username}`);

    const bucketIdMatch = storyUrl.match(/stories\/(\d+)/);
    if (!bucketIdMatch) throw new Error('Không tìm thấy bucket ID trong URL');

    const bucketId = bucketIdMatch[1];
    console.log(`   🆔 Bucket ID: ${bucketId}`);

    let bucketData = null;
    storyData.require?.forEach(req => {
      if (req?.[3]?.[0]?.__bbox?.result?.data?.bucket?.id === bucketId) {
        bucketData = req[3][0].__bbox.result.data.bucket;
      }
    });

    if (!bucketData) throw new Error('Không tìm thấy bucket data - story có thể đã hết hạn');

    const nodes = bucketData.unified_stories_with_notes?.edges || [];
    console.log(`   📊 Tìm thấy ${nodes.length} story items`);
    
    if (!nodes.length) {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `ℹ️ Story ${storyUrl} không có media.`);
      return;
    }

    const folderName = `${username} - ${today} - SINGLE`;
    const folderPath = path.join(__dirname, 'temp', folderName);
    await fs.mkdir(folderPath, { recursive: true });

    let downloadedFiles = [];

    for (const edge of nodes) {
      const node = edge.node;
      if (node?.story_card_info?.bucket?.camera_post_type === 'ADMINED_ADDITIONAL_PROFILE_STORY') continue;

      const media = node?.attachments?.[0]?.media;
      if (!media?.id) continue;

      const id = media.id;
      if (await isDownloaded(id, today)) {
        console.log(`   ⏭️  Đã download: ${id}`);
        continue;
      }

      let filePath = null;

      if (media.__typename === 'Photo') {
        console.log(`   📷 Downloading photo: ${id}`);
        filePath = await downloadPhoto(media, username, folderPath, id);
      } else if (media.__typename === 'Video') {
        console.log(`   🎥 Downloading video: ${id}`);
        filePath = await downloadFacebookStoryVideo(media, username, folderPath, id);
      }

      if (filePath) {
        downloadedFiles.push(filePath);
        await markDownloaded(id, today);
        console.log(`   ✅ Downloaded: ${path.basename(filePath)}`);
      }
    }

    if (downloadedFiles.length > 0) {
      await zipAndSend(folderPath, folderName);
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `✅ Đã tải và gửi ${downloadedFiles.length} file từ story của ${username}`);
      console.log(`   📦 Đã gửi zip với ${downloadedFiles.length} files`);
    } else {
      await fs.rm(folderPath, { recursive: true, force: true }).catch(() => {});
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `ℹ️ Không có media mới từ story: ${storyUrl}`);
      console.log(`   ℹ️  Không có file mới để download`);
    }
  } catch (err) {
    console.error(`❌ Lỗi xử lý story:`, err);
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, `❌ Lỗi:\n${err.message}\n\n💡 Thử:\n1. Kiểm tra cookie: /test\n2. Lấy cookie mới: /cookie\n3. Set lại: SETCOOKIE ...`);
    throw err;
  }
}

// ──────────────────────────────────────── Khởi động Bot với Webhook ────────────────────────────────────────
const app = express();

app.get('/', (req, res) => {
  res.send('Facebook Story Downloader Bot is running!');
});

const SECRET_PATH = '/telegraf/' + TELEGRAM_TOKEN.replace(/:/g, '');

app.use(bot.webhookCallback(SECRET_PATH));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server chạy trên port ${PORT}`);

  const webhookUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'your-render-app-name.onrender.com'}${SECRET_PATH}`;
  try {
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`Webhook đã set thành công: ${webhookUrl}`);
  } catch (err) {
    console.error('Lỗi set webhook:', err);
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

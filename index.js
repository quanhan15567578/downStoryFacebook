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

// ──────────────────────────────────────── Middleware ────────────────────────────────────────
bot.use(async (ctx, next) => {
  if (ctx.from.id !== ADMIN_CHAT_ID) {
    if (['/start', '/help'].includes(ctx.message?.text)) {
      return next();
    }
    return ctx.reply('Bạn không có quyền sử dụng bot này.');
  }
  await next();
});

// ──────────────────────────────────────── Commands ────────────────────────────────────────
bot.command('start', (ctx) => ctx.reply(`🤖 Facebook Story Downloader Bot

📋 LỆNH CƠ BẢN:
/startdl → chạy tất cả profiles
/list → xem danh sách profiles
/cookie → hướng dẫn lấy cookie
/showcookie → xem cookie hiện tại
/debug <url> → debug story URL

✍️ LỆNH NHANH:
DOWN <url> → tải 1 story
ADD <url> → thêm profile
REMOVE <url> → xóa profile
SETCOOKIE <cookie> → set cookie mới

📝 VÍ DỤ:
DOWN https://facebook.com/stories/123
ADD facebook.com/username
SETCOOKIE c_user=123;xs=abc...`));

bot.command('help', (ctx) => ctx.reply('Gửi /start để xem hướng dẫn đầy đủ'));

bot.command('showcookie', (ctx) => {
  const cookie = getCookieString();
  if (!cookie) {
    return ctx.reply('⚠️ Chưa có cookie nào được set.\n\nDùng lệnh:\nSETCOOKIE <cookie_string>');
  }
  
  const preview = cookie.length > 100 ? cookie.substring(0, 100) + '...' : cookie;
  ctx.reply(`🍪 Cookie hiện tại:\n${preview}\n\n📊 Độ dài: ${cookie.length} ký tự`);
});

bot.command('cookie', (ctx) => {
  ctx.reply(`📖 HƯỚNG DẪN LẤY COOKIE:

1️⃣ Mở Facebook trong Chrome
2️⃣ Nhấn F12 → tab "Application"
3️⃣ Chọn Cookies → facebook.com
4️⃣ Copy các giá trị:
   • c_user (BẮT BUỘC)
   • xs (BẮT BUỘC)
   • datr (nên có)
   • sb (nên có)

5️⃣ Ghép thành:
c_user=VALUE;xs=VALUE;datr=VALUE;sb=VALUE

6️⃣ Gửi:
SETCOOKIE c_user=123;xs=abc...

⚠️ Cookie hết hạn sau 2-4 tuần`);
});

bot.hears(/^SETCOOKIE\s+(.+)$/is, async (ctx) => {
  const cookieString = ctx.match[1].trim();
  
  if (!cookieString.includes('c_user') || !cookieString.includes('xs')) {
    return ctx.reply('❌ Cookie không hợp lệ!\n\nCần ít nhất: c_user và xs\n\nVí dụ:\nSETCOOKIE c_user=123;xs=abc...');
  }
  
  saveCookies(cookieString);
  ctx.reply('✅ Đã lưu cookie!\n\nTest bằng:\n/debug <story_url>');
  
  try {
    await ctx.deleteMessage();
  } catch (err) {
    console.log('Cannot delete message');
  }
});

// ✅ LỆNH DEBUG MỚI
bot.command('debug', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.reply('Dùng: /debug <story_url>\n\nVí dụ:\n/debug https://facebook.com/stories/123');
  }
  
  const url = args[1];
  const cookie = getCookieString();
  
  if (!cookie) {
    return ctx.reply('⚠️ Chưa có cookie! Dùng /cookie để xem hướng dẫn.');
  }
  
  ctx.reply('🔍 Đang debug...');
  await debugStoryUrl(url, ctx);
});

bot.command('startdl', async (ctx) => {
  const cookie = getCookieString();
  if (!cookie) {
    return ctx.reply('⚠️ Chưa có cookie! Dùng /cookie để xem hướng dẫn.');
  }
  
  ctx.reply('🚀 Bắt đầu kiểm tra và download stories...');
  await processAllProfiles();
  ctx.reply('✅ Hoàn tất kiểm tra hôm nay.');
});

bot.hears(/^DOWN\s+(https?:\/\/.+)$/i, async (ctx) => {
  const url = ctx.match[1].trim();
  const cookie = getCookieString();
  
  if (!cookie) {
    return ctx.reply('⚠️ Chưa có cookie! Dùng /cookie để xem hướng dẫn.');
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
  ctx.reply(`✅ Đã thêm: ${url}`);
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
  return new Date().toISOString().slice(0, 10);
}

async function cleanOldDownloaded() {
  const today = await getTodayKey();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  db.read();
  const state = db.data.downloaded || {};
  Object.keys(state).forEach(key => {
    if (key !== today && key !== yesterday) {
      delete db.data.downloaded[key];
    }
  });
  db.write();
}

async function isDownloaded(id, dateKey) {
  db.read();
  return (db.data.downloaded?.[dateKey] || []).includes(id);
}

async function markDownloaded(id, dateKey) {
  db.read();
  if (!db.data.downloaded) db.data.downloaded = {};
  if (!db.data.downloaded[dateKey]) db.data.downloaded[dateKey] = [];
  if (!db.data.downloaded[dateKey].includes(id)) {
    db.data.downloaded[dateKey].push(id);
    db.write();
  }
}

function getUsernameFromStoryData(storyData) {
  try {
    const bucket = storyData?.require
      ?.find(r => r?.[3]?.[0]?.__bbox?.result?.data?.bucket)
      ?.[3][0].__bbox.result.data.bucket;

    return (
      bucket?.story_bucket_owner?.name ||
      bucket?.story_bucket_owner?.short_name ||
      bucket?.owner?.name ||
      'Unknown'
    );
  } catch {
    return 'Unknown';
  }
}

async function fetchWithHeaders(url) {
  const cookie = getCookieString();
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
  };
  
  if (cookie) {
    headers['Cookie'] = cookie;
  }
  
  return axios.get(url, {
    headers,
    maxRedirects: 5,
    timeout: 30000,
  });
}

// ──────────────────────────────────────── Fetch Story ────────────────────────────────────────
async function fetchProfileHtml(profileUrl) {
  const res = await fetchWithHeaders(profileUrl);
  return res.data;
}

async function extractStoryUrlFromProfile(html) {
  const $ = cheerio.load(html);
  let storyHref = null;
  $('a[href*="/stories/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('/stories/') && !href.includes('/share/')) {
      storyHref = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
      return false;
    }
  });
  return storyHref;
}

// ✅ CẢI THIỆN HÀM PARSE JSON
async function fetchStoryJson(storyUrl, debug = false) {
  const res = await fetchWithHeaders(storyUrl);
  const html = res.data;
  
  if (debug) {
    // Lưu HTML để debug
    const debugPath = path.join(__dirname, 'temp', 'debug-story.html');
    await fs.mkdir(path.join(__dirname, 'temp'), { recursive: true });
    await fs.writeFile(debugPath, html, 'utf8');
    console.log(`💾 Đã lưu HTML vào: ${debugPath}`);
  }
  
  const $ = cheerio.load(html);
  let foundScripts = 0;
  let target = null;

  // Thử nhiều cách parse
  $('script[type="application/json"]').each((_, el) => {
    foundScripts++;
    try {
      const rawText = $(el).html();
      if (!rawText) return;
      
      const data = JSON.parse(rawText);
      
      if (debug) {
        console.log(`📜 Script #${foundScripts}:`, {
          hasRequire: !!data?.require,
          requireLength: data?.require?.length || 0,
          keys: Object.keys(data).slice(0, 5)
        });
      }
      
      // Tìm bucket data
      if (data?.require) {
        for (const req of data.require) {
          if (req?.[3]?.[0]?.__bbox?.result?.data?.bucket?.id) {
            target = data;
            if (debug) {
              console.log(`✅ Tìm thấy bucket trong script #${foundScripts}`);
            }
            return false; // break
          }
        }
      }
    } catch (err) {
      if (debug) {
        console.log(`❌ Script #${foundScripts} parse error:`, err.message);
      }
    }
  });

  if (debug) {
    console.log(`📊 Tổng số scripts tìm thấy: ${foundScripts}`);
    console.log(`🎯 Tìm thấy story data: ${!!target}`);
  }

  return target;
}

// ✅ HÀM DEBUG MỚI
async function debugStoryUrl(storyUrl, ctx) {
  try {
    await ctx.reply('🔍 Bước 1: Fetch HTML...');
    const storyData = await fetchStoryJson(storyUrl, true);
    
    if (!storyData) {
      await ctx.reply('❌ Không tìm thấy story data trong HTML\n\nCó thể:\n1. URL không phải story\n2. Story đã bị xóa\n3. Cookie hết hạn\n4. Bạn không có quyền xem story này');
      return;
    }
    
    await ctx.reply('✅ Bước 2: Parse JSON thành công!');
    
    const username = getUsernameFromStoryData(storyData);
    await ctx.reply(`👤 Username: ${username}`);
    
    const bucketIdMatch = storyUrl.match(/stories\/(\d+)/);
    if (!bucketIdMatch) {
      await ctx.reply('❌ Không tìm thấy bucket ID trong URL');
      return;
    }
    
    const bucketId = bucketIdMatch[1];
    await ctx.reply(`🆔 Bucket ID: ${bucketId}`);
    
    let bucketData = null;
    storyData.require?.forEach(req => {
      if (req?.[3]?.[0]?.__bbox?.result?.data?.bucket?.id === bucketId) {
        bucketData = req[3][0].__bbox.result.data.bucket;
      }
    });
    
    if (!bucketData) {
      await ctx.reply('❌ Không tìm thấy bucket data');
      return;
    }
    
    await ctx.reply('✅ Bước 3: Tìm thấy bucket data!');
    
    const nodes = bucketData.unified_stories_with_notes?.edges || [];
    await ctx.reply(`📊 Số story items: ${nodes.length}`);
    
    if (nodes.length > 0) {
      const node = nodes[0].node;
      const media = node?.attachments?.[0]?.media;
      await ctx.reply(`📷 Media type: ${media?.__typename || 'Unknown'}\n🆔 Media ID: ${media?.id || 'N/A'}`);
    }
    
    await ctx.reply('✅ DEBUG HOÀN TẤT!\n\nStory này có thể download được. Dùng:\nDOWN ' + storyUrl);
    
  } catch (err) {
    await ctx.reply(`❌ Lỗi debug:\n${err.message}\n\nStack:\n${err.stack?.slice(0, 500)}`);
  }
}

// ──────────────────────────────────────── DASH Parser ────────────────────────────────────────
function parseDashManifest(xml) {
  if (!xml) return { video: null, audio: null };
  const parser = new DOMParser();
  const dom = parser.parseFromString(xml, 'application/xml');
  if (dom.querySelector('parsererror')) return { video: null, audio: null };

  let video = null, audio = null, maxQ = 0;

  dom.querySelectorAll('AdaptationSet').forEach(set => {
    set.querySelectorAll('Representation').forEach(rep => {
      const baseUrl = rep.querySelector('BaseURL')?.textContent?.trim();
      if (!baseUrl) return;

      const qLabel = rep.getAttribute('FBQualityLabel') || '';
      const qNum = parseInt(qLabel.replace('p', ''), 10) || 0;

      if (rep.querySelector('AudioChannelConfiguration')) {
        audio = { uri: baseUrl, label: 'audio' };
      } else if (qNum > maxQ) {
        video = { uri: baseUrl, label: qLabel || `${qNum}p`, quality: qNum };
        maxQ = qNum;
      }
    });
  });

  return { video, audio };
}

async function downloadFile(url, outputPath) {
  try {
    const res = await axios.get(url, { responseType: 'stream', timeout: 60000 });
    const writer = (await fs.open(outputPath, 'w')).createWriteStream();
    res.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    return true;
  } catch (err) {
    console.error(`Download failed: ${url} → ${err.message}`);
    return false;
  }
}

// ──────────────────────────────────────── Download Logic ────────────────────────────────────────
async function downloadFacebookStoryVideo(media, username, folderPath, id) {
  const baseName = `${id} - ${username.replace(/[^a-zA-Z0-9]/g, '_')}`;
  
  const dash = media?.video_dash_manifest;
  const progressive = media?.browser_native_hd_url || media?.browser_native_sd_url 
    ? [
        { progressive_url: media.browser_native_hd_url, metadata: { quality: 'HD' } },
        { progressive_url: media.browser_native_sd_url, metadata: { quality: 'SD' } }
      ]
    : (media?.playable_url_quality_hd || media?.playable_url)
      ? [{ progressive_url: media.playable_url_quality_hd || media.playable_url, metadata: { quality: 'HD' } }]
      : [];

  if (dash) {
    const parsed = parseDashManifest(dash);
    if (parsed.video) {
      const videoTemp = path.join(folderPath, `${baseName}.video.mp4`);
      const audioTemp = path.join(folderPath, `${baseName}.audio.mp4`);
      const finalPath = path.join(folderPath, `${baseName}.DASH_${parsed.video.quality || 'HQ'}.mp4`);

      const vOk = await downloadFile(parsed.video.uri, videoTemp);
      if (!vOk) return null;

      if (parsed.audio) {
        const aOk = await downloadFile(parsed.audio.uri, audioTemp);
        if (aOk) {
          try {
            await execPromise(`ffmpeg -i "${videoTemp}" -i "${audioTemp}" -c copy "${finalPath}"`);
            await fs.unlink(videoTemp).catch(() => {});
            await fs.unlink(audioTemp).catch(() => {});
          } catch {
            await fs.rename(videoTemp, finalPath).catch(() => {});
          }
        } else {
          await fs.rename(videoTemp, finalPath).catch(() => {});
        }
      } else {
        await fs.rename(videoTemp, finalPath).catch(() => {});
      }
      console.log(`DASH high quality → ${finalPath}`);
      return finalPath;
    }
  }

  const hdUrl = progressive.find(p => p.metadata?.quality === 'HD')?.progressive_url;
  const sdUrl = progressive.find(p => p.metadata?.quality === 'SD')?.progressive_url;

  const targetUrl = hdUrl || sdUrl;
  if (!targetUrl) return null;

  const quality = hdUrl ? 'HD' : 'SD';
  const targetPath = path.join(folderPath, `${baseName}.${quality}.mp4`);

  const ok = await downloadFile(targetUrl, targetPath);
  if (ok) {
    console.log(`Progressive ${quality} → ${targetPath}`);
    return targetPath;
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
  }
  
  console.log(`\n✅ Hoàn tất xử lý tất cả profiles\n`);
}

async function processSingleStory(storyUrl, ctx) {
  const today = await getTodayKey();
  let username = 'Unknown_Single';

  try {
    console.log(`📖 Đang xử lý story: ${storyUrl}`);
    
    const storyData = await fetchStoryJson(storyUrl);
    if (!storyData) throw new Error('Không lấy được dữ liệu story - thử dùng /debug để kiểm tra');

    username = getUsernameFromStoryData(storyData);
    console.log(`   👤 Username: ${username}`);

    const bucketIdMatch = storyUrl.match(/stories\/(\d+)/);
    if (!bucketIdMatch) throw new Error('Không tìm thấy bucket ID');

    const bucketId = bucketIdMatch[1];
    console.log(`   🆔 Bucket ID: ${bucketId}`);

    let bucketData = null;
    storyData.require?.forEach(req => {
      if (req?.[3]?.[0]?.__bbox?.result?.data?.bucket?.id === bucketId) {
        bucketData = req[3][0].__bbox.result.data.bucket;
      }
    });

    if (!bucketData) throw new Error('Không tìm thấy bucket data');

    const nodes = bucketData.unified_stories_with_notes?.edges || [];
    console.log(`   📊 Tìm thấy ${nodes.length} story items`);
    
    if (!nodes.length) {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `ℹ️ Story ${storyUrl} không có media mới.`);
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
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `✅ Đã tải và gửi ${downloadedFiles.length} file từ story riêng lẻ của ${username}`);
      console.log(`   📦 Đã gửi zip với ${downloadedFiles.length} files`);
    } else {
      await fs.rm(folderPath, { recursive: true, force: true }).catch(() => {});
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `ℹ️ Không có media mới từ story: ${storyUrl}`);
      console.log(`   ℹ️  Không có file mới để download`);
    }
  } catch (err) {
    console.error(`❌ Lỗi xử lý story:`, err);
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, `❌ Lỗi khi xử lý story:\n${err.message}\n\n💡 Thử dùng /debug ${storyUrl}`);
    throw err;
  }
}

// ──────────────────────────────────────── Khởi động Bot ────────────────────────────────────────
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

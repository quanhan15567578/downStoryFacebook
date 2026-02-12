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
const defaultData = { profiles: [], downloaded: {} };
const db = new LowSync(adapter, defaultData);

// ✅ FIX 1: Đọc database từ file trước khi sử dụng
db.read();

// Đảm bảo default data nếu file trống/corrupt
if (!db.data) {
  db.data = { profiles: [], downloaded: {} };
  db.write();
}

const execPromise = util.promisify(exec);

// Token từ env (bắt buộc!)
const TELEGRAM_TOKEN = '8578868890:AAFs1-9_CDQYF81GRVeAJcZI5p_lFuViInc';

const ADMIN_CHAT_ID = 452130340;  // Nếu muốn, chuyển sang process.env.ADMIN_CHAT_ID

const bot = new Telegraf(TELEGRAM_TOKEN);

// ──────────────────────────────────────── Helper: Normalize URL ────────────────────────────────────────
// ✅ FIX 2: Hàm chuẩn hóa URL để đảm bảo có https:// và www.
function normalizeProfileUrl(url) {
  let normalized = url.trim();
  
  // Thêm https:// nếu thiếu
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = 'https://' + normalized;
  }
  
  // Thêm www. nếu thiếu (Facebook thường yêu cầu www)
  normalized = normalized.replace('https://facebook.com/', 'https://www.facebook.com/');
  normalized = normalized.replace('http://facebook.com/', 'https://www.facebook.com/');
  
  return normalized;
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
bot.command('start', (ctx) => ctx.reply('Facebook Story Downloader Bot\n\nDùng các lệnh:\n/startdl → chạy tất cả\nDOWN <url story> → tải 1 story\nADD <profile url> → thêm profile\nREMOVE <url hoặc username> → xoá\n/list → xem danh sách'));

bot.command('help', (ctx) => ctx.reply('Các lệnh:\n/startdl\nDOWN https://...\nADD https://www.facebook.com/...\nREMOVE https://... hoặc REMOVE username\n/list'));

bot.command('startdl', async (ctx) => {
  ctx.reply('Bắt đầu kiểm tra và download stories...');
  await processAllProfiles();
  ctx.reply('Hoàn tất kiểm tra hôm nay.');
});

bot.hears(/^DOWN\s+(https?:\/\/.+)$/i, async (ctx) => {
  const url = ctx.match[1].trim();
  ctx.reply(`Đang xử lý story: ${url}`);
  try {
    await processSingleStory(url, ctx);
  } catch (err) {
    ctx.reply(`❌ LỖI: ${err.message}`);
  }
});

bot.hears(/^ADD\s+(.+)$/i, async (ctx) => {
  let url = ctx.match[1].trim();
  
  // Chuẩn hóa URL
  url = normalizeProfileUrl(url);

  // Reload data để đảm bảo có data mới nhất
  db.read();
  const profiles = db.data.profiles || [];
  
  if (profiles.includes(url)) {
    return ctx.reply('Profile này đã có trong danh sách.');
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
    return ctx.reply('Không tìm thấy profile để xoá.');
  }

  db.data.profiles = newProfiles;
  db.write();
  ctx.reply(`✅ Đã xoá: ${url}`);
});

bot.command('list', (ctx) => {
  db.read(); // Đảm bảo đọc data mới nhất
  const profiles = db.data.profiles || [];
  if (!profiles.length) return ctx.reply('Danh sách trống.');
  ctx.reply(`📋 Danh sách profiles (${profiles.length}):\n${profiles.slice(0, 50).join('\n')}${profiles.length > 50 ? `\n\n... và ${profiles.length - 50} profile khác` : ''}`);
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
  return axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
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
      return false; // dừng each
    }
  });
  return storyHref;
}

async function fetchStoryJson(storyUrl) {
  const res = await fetchWithHeaders(storyUrl);
  const html = res.data;
  const $ = cheerio.load(html);
  let target = null;

  $('script[type="application/json"][data-sjs]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      if (data?.require?.some(r => r?.[3]?.[0]?.__bbox?.result?.data?.bucket?.id)) {
        target = data;
        return false;
      }
    } catch {}
  });

  return target;
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

  // Ưu tiên DASH
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

  // Fallback progressive
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
    // ✅ Chuẩn hóa URL trước khi fetch
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
  db.read(); // Đảm bảo load data mới nhất
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
    if (!storyData) throw new Error('Không lấy được dữ liệu story');

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
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, `❌ Lỗi khi xử lý story:\n${err.message}\n\nStack: ${err.stack?.slice(0, 500)}`);
    throw err;
  }
}

// ──────────────────────────────────────── Khởi động Bot với Webhook ────────────────────────────────────────
const app = express();

// Để Render check healthy
app.get('/', (req, res) => {
  res.send('Facebook Story Downloader Bot is running!');
});

// Webhook path (nên secret để tránh abuse)
const SECRET_PATH = '/telegraf/' + TELEGRAM_TOKEN.replace(/:/g, '');  // Làm secret dựa trên token

app.use(bot.webhookCallback(SECRET_PATH));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server chạy trên port ${PORT}`);

  // Set webhook
  const webhookUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'your-render-app-name.onrender.com'}${SECRET_PATH}`;
  try {
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`Webhook đã set thành công: ${webhookUrl}`);
  } catch (err) {
    console.error('Lỗi set webhook:', err);
  }
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

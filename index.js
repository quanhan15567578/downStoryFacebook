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

// Đảm bảo default
if (!db.data) {
  db.data = { profiles: [], downloaded: {} };
  db.write();
}

const execPromise = util.promisify(exec);

// Token từ env (bắt buộc!)
const TELEGRAM_TOKEN = '8578868890:AAFs1-9_CDQYF81GRVeAJcZI5p_lFuViInc';

const ADMIN_CHAT_ID = 452130340;  // Nếu muốn, chuyển sang process.env.ADMIN_CHAT_ID

const bot = new Telegraf(TELEGRAM_TOKEN);

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
bot.command('start', (ctx) => ctx.reply('Facebook Story Downloader Bot\n\nDùng các lệnh:\n/startdl → chạy tất cả\nX <url story> → tải 1 story\nY <profile url> → thêm profile\nDEL <url hoặc username> → xoá\n/list → xem danh sách'));

bot.command('help', (ctx) => ctx.reply('Các lệnh:\n/startdl\nX https://...\nY https://www.facebook.com/...\nDEL https://... hoặc DEL username\n/list'));

bot.command('startdl', async (ctx) => {
  ctx.reply('Bắt đầu kiểm tra và download stories...');
  await processAllProfiles();
  ctx.reply('Hoàn tất kiểm tra hôm nay.');
});

bot.hears(/^X\s+(https?:\/\/.+)$/i, async (ctx) => {
  const url = ctx.match[1].trim();
  ctx.reply(`Đang xử lý story: ${url}`);
  await processSingleStory(url);
  ctx.reply('Xong lệnh X.');
});

bot.hears(/^Y\s+(https?:\/\/facebook\.com\/[^\/\s]+)$/i, async (ctx) => {
  let url = ctx.match[1].trim();
  if (!url.startsWith('https://')) url = 'https://' + url;

  const profiles = db.data.profiles || [];
  if (profiles.includes(url) || profiles.includes(url.replace('www.', ''))) {
    return ctx.reply('Profile này đã có trong danh sách.');
  }

  db.data.profiles.push(url);
  db.write();
  ctx.reply(`Đã thêm profile: ${url}`);
});

bot.hears(/^DEL\s+(.+)$/i, async (ctx) => {
  let input = ctx.match[1].trim();
  let url;

  if (input.startsWith('http')) {
    url = input.trim();
  } else {
    url = `https://www.facebook.com/${input.trim()}`;
  }

  const profiles = db.data.profiles || [];
  const normalized = [url, url.replace('www.', ''), url.replace('https://facebook.com/', 'https://www.facebook.com/')];

  const newProfiles = profiles.filter(p => !normalized.includes(p));

  if (newProfiles.length === profiles.length) {
    return ctx.reply('Không tìm thấy profile để xoá.');
  }

  db.data.profiles = newProfiles;
  db.write();
  ctx.reply(`Đã xoá: ${url}`);
});

bot.command('list', (ctx) => {
  const profiles = db.data.profiles || [];
  if (!profiles.length) return ctx.reply('Danh sách trống.');
  ctx.reply(`Danh sách profiles (${profiles.length}):\n${profiles.join('\n')}`);
});

// ──────────────────────────────────────── Utils ────────────────────────────────────────
async function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function cleanOldDownloaded() {
  const today = await getTodayKey();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const state = db.data.downloaded || {};
  Object.keys(state).forEach(key => {
    if (key !== today && key !== yesterday) {
      delete db.data.downloaded[key];
    }
  });
  db.write();
}

async function isDownloaded(id, dateKey) {
  return (db.data.downloaded?.[dateKey] || []).includes(id);
}

async function markDownloaded(id, dateKey) {
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
  const progressive = media?.videoDeliveryResponseFragment?.videoDeliveryResponseResult?.progressive_urls || [];
  const dashManifests = media?.videoDeliveryResponseFragment?.videoDeliveryResponseResult?.dash_manifests || [];

  let hasHighDash = false;
  let dashVideoUrl, dashAudioUrl, dashQualityLabel;

  if (dashManifests.length > 0 && dashManifests[0]?.manifest_xml) {
    try {
      const parsed = parseDashManifest(dashManifests[0].manifest_xml);
      if (parsed.video && parsed.video.quality > 720) {
        hasHighDash = true;
        dashVideoUrl = parsed.video.uri;
        dashAudioUrl = parsed.audio?.uri;
        dashQualityLabel = parsed.video.label || `${parsed.video.quality}p`;
      }
    } catch (e) {
      console.warn(`DASH parse error for ${id}: ${e.message}`);
    }
  }

  const baseName = `${id} - ${username.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const finalPath = path.join(folderPath, `${baseName}.${hasHighDash ? dashQualityLabel : 'HD/SD'}.mp4`);

  if (hasHighDash) {
    const videoTemp = path.join(folderPath, `${baseName}.video.mp4`);
    const audioTemp = dashAudioUrl ? path.join(folderPath, `${baseName}.audio.m4a`) : null;

    const vOk = await downloadFile(dashVideoUrl, videoTemp);
    if (!vOk) return null;

    if (audioTemp) {
      const aOk = await downloadFile(dashAudioUrl, audioTemp);
      if (aOk) {
        try {
          await execPromise(
            `ffmpeg -i "${videoTemp}" -i "${audioTemp}" -c copy -map 0:v:0 -map 1:a:0 "${finalPath}" -y`
          );
          await fs.unlink(videoTemp).catch(() => {});
          await fs.unlink(audioTemp).catch(() => {});
        } catch (mergeErr) {
          console.error(`Merge failed for ${id}, keeping video only`, mergeErr);
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
    const html = await fetchProfileHtml(profileUrl);
    const storyUrl = await extractStoryUrlFromProfile(html);
    if (!storyUrl) return;

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
      console.log(`Gửi zip cho ${username} - ${downloadedFiles.length} file`);
    } else {
      await fs.rm(folderPath, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    console.error(`Lỗi profile ${profileUrl} (${username}):`, err.message);
  }
}

async function processAllProfiles() {
  await cleanOldDownloaded();
  const profiles = db.data.profiles || [];
  for (const url of profiles) {
    await processProfile(url);
  }
}

async function processSingleStory(storyUrl) {
  const today = await getTodayKey();
  let username = 'Unknown_Single';

  try {
    const storyData = await fetchStoryJson(storyUrl);
    if (!storyData) throw new Error('Không lấy được dữ liệu story');

    username = getUsernameFromStoryData(storyData);

    const bucketIdMatch = storyUrl.match(/stories\/(\d+)/);
    if (!bucketIdMatch) throw new Error('Không tìm thấy bucket ID');

    const bucketId = bucketIdMatch[1];

    let bucketData = null;
    storyData.require?.forEach(req => {
      if (req?.[3]?.[0]?.__bbox?.result?.data?.bucket?.id === bucketId) {
        bucketData = req[3][0].__bbox.result.data.bucket;
      }
    });

    if (!bucketData) throw new Error('Không tìm thấy bucket data');

    const nodes = bucketData.unified_stories_with_notes?.edges || [];
    if (!nodes.length) {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `Story ${storyUrl} không có media mới.`);
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
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `Đã tải và gửi ${downloadedFiles.length} file từ story riêng lẻ.`);
    } else {
      await fs.rm(folderPath, { recursive: true, force: true }).catch(() => {});
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `Không có media mới từ story: ${storyUrl}`);
    }
  } catch (err) {
    console.error(`Lỗi xử lý story riêng: ${storyUrl}`, err);
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, `Lỗi khi xử lý story:\n${err.message}`);
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

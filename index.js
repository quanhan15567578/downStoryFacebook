const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const archiver = require('archiver');
const { LowSync } = require('lowdb');
const { JSONFileSync } = require('lowdb/node');
const express = require('express');

const adapter = new JSONFileSync('database.json');
const defaultData = { profiles: [], downloaded: {}, access_token: null };
const db = new LowSync(adapter, defaultData);

db.read();

if (!db.data) {
  db.data = { profiles: [], downloaded: {}, access_token: null };
  db.write();
}

const execPromise = util.promisify(exec);

const TELEGRAM_TOKEN = '8578868890:AAFs1-9_CDQYF81GRVeAJcZI5p_lFuViInc';
const ADMIN_CHAT_ID = 452130340;

const bot = new Telegraf(TELEGRAM_TOKEN);

// ──────────────────────────────────────── Access Token Management ────────────────────────────────────────
function getAccessToken() {
  db.read();
  return db.data.access_token || null;
}

function saveAccessToken(token) {
  db.read();
  db.data.access_token = token;
  db.write();
  console.log('✅ Đã lưu access token vào database');
}

// ──────────────────────────────────────── Helper ────────────────────────────────────────
function normalizeProfileUrl(url) {
  let normalized = url.trim();
  
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = 'https://' + normalized;
  }
  
  normalized = normalized.replace('https://facebook.com/', 'https://www.facebook.com/');
  normalized = normalized.replace('http://facebook.com/', 'https://www.facebook.com/');
  
  return normalized;
}

function extractUsernameFromUrl(url) {
  // Extract username/id from Facebook URL
  const match = url.match(/facebook\.com\/([^\/\?]+)/);
  return match ? match[1] : null;
}

function extractStoryId(url) {
  // Extract story ID from story URL
  const match = url.match(/stories\/(\d+)/);
  return match ? match[1] : null;
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
bot.command('start', (ctx) => ctx.reply(`🤖 Facebook Story Downloader Bot (Graph API)

📖 HƯỚNG DẪN:

1. Lấy Access Token:
   /token → Xem hướng dẫn lấy token
   SETTOKEN <token> → Set token mới

2. Quản lý profiles:
   ADD <url> → Thêm profile
   REMOVE <url> → Xóa profile
   /list → Xem danh sách

3. Download:
   DOWN <story_url> → Tải 1 story
   /startdl → Tải tất cả profiles

4. Tiện ích:
   /test → Test token
   /showtoken → Xem token hiện tại`));

bot.command('help', (ctx) => ctx.reply('Gửi /start để xem hướng dẫn đầy đủ'));

bot.command('token', (ctx) => {
  ctx.reply(`📖 HƯỚNG DẪN LẤY ACCESS TOKEN:

**CÁCH 1: Dùng Graph API Explorer (Khuyên dùng)**
1. Mở: https://developers.facebook.com/tools/explorer
2. Click "Get User Access Token"
3. Chọn quyền:
   ✅ user_photos
   ✅ user_videos
   ✅ user_posts
4. Click "Generate Access Token"
5. Copy token và gửi:
   SETTOKEN <token_bạn_vừa_copy>

**CÁCH 2: Dùng Bookmark Script**
1. Tạo bookmark với code:
javascript:(function(){prompt('Access Token',require('AccessToken').getToken())})();

2. Mở Facebook, click bookmark
3. Copy token và gửi:
   SETTOKEN <token>

**LƯU Ý:**
• Token hết hạn sau 2 tháng
• Cần token có quyền user_photos, user_videos
• KHÔNG chia sẻ token với người khác`);
});

bot.command('showtoken', (ctx) => {
  const token = getAccessToken();
  if (!token) {
    return ctx.reply('⚠️ Chưa có token!\n\nDùng lệnh /token để xem hướng dẫn.');
  }
  
  const preview = token.length > 50 ? token.substring(0, 50) + '...' : token;
  ctx.reply(`🔑 Access Token:\n${preview}\n\n📊 Độ dài: ${token.length} ký tự`);
});

bot.command('test', async (ctx) => {
  const token = getAccessToken();
  if (!token) {
    return ctx.reply('⚠️ Chưa có token! Dùng /token để xem hướng dẫn.');
  }
  
  ctx.reply('🔍 Đang test token...');
  
  try {
    // Test token bằng cách lấy thông tin user
    const response = await axios.get(`https://graph.facebook.com/v18.0/me`, {
      params: {
        access_token: token,
        fields: 'id,name'
      }
    });
    
    ctx.reply(`✅ Token hoạt động tốt!\n\n👤 Logged in as: ${response.data.name}\n🆔 User ID: ${response.data.id}`);
  } catch (err) {
    ctx.reply(`❌ Token không hợp lệ hoặc đã hết hạn!\n\nLỗi: ${err.response?.data?.error?.message || err.message}\n\nHãy lấy token mới: /token`);
  }
});

bot.hears(/^SETTOKEN\s+(.+)$/is, async (ctx) => {
  const token = ctx.match[1].trim();
  
  // Validate token format (Facebook tokens thường dài 100-300 ký tự)
  if (token.length < 50) {
    return ctx.reply('❌ Token không hợp lệ! Token phải dài ít nhất 50 ký tự.\n\nDùng /token để xem hướng dẫn lấy token.');
  }
  
  // Test token trước khi lưu
  try {
    await axios.get(`https://graph.facebook.com/v18.0/me`, {
      params: { access_token: token, fields: 'id' }
    });
    
    saveAccessToken(token);
    ctx.reply('✅ Đã lưu token thành công!\n\nDùng /test để kiểm tra chi tiết\nHoặc DOWN <story_url> để tải story');
    
    // Xóa message chứa token
    try {
      await ctx.deleteMessage();
    } catch (err) {}
  } catch (err) {
    ctx.reply(`❌ Token không hợp lệ!\n\nLỗi: ${err.response?.data?.error?.message || err.message}\n\nHãy kiểm tra lại token: /token`);
  }
});

bot.command('startdl', async (ctx) => {
  const token = getAccessToken();
  if (!token) {
    return ctx.reply('⚠️ Chưa có token! Dùng /token để xem hướng dẫn.');
  }
  
  ctx.reply('🚀 Bắt đầu kiểm tra và download stories...');
  await processAllProfiles();
  ctx.reply('✅ Hoàn tất kiểm tra hôm nay.');
});

bot.hears(/^DOWN\s+(https?:\/\/.+)$/i, async (ctx) => {
  const url = ctx.match[1].trim();
  const token = getAccessToken();
  
  if (!token) {
    return ctx.reply('⚠️ Chưa có token! Dùng /token để xem hướng dẫn.');
  }
  
  ctx.reply(`📥 Đang xử lý story: ${url}`);
  try {
    await processSingleStory(url, ctx);
  } catch (err) {
    ctx.reply(`❌ LỖI: ${err.message}\n\n💡 Thử:\n1. /test → Kiểm tra token\n2. /token → Lấy token mới`);
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
    url = `https://www.facebook.com/${input}`;
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
    return ctx.reply('❌ Không tìm thấy profile.');
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
  ctx.reply(`📋 Danh sách (${profiles.length}):\n\n${preview}${more}`);
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

// ──────────────────────────────────────── Graph API Functions ────────────────────────────────────────
async function getUserStories(userId) {
  const token = getAccessToken();
  
  try {
    // Lấy stories từ Graph API
    const response = await axios.get(`https://graph.facebook.com/v18.0/${userId}/stories`, {
      params: {
        access_token: token,
        fields: 'id,from,created_time,permalink_url,attachments{media,media_type,url,subattachments}'
      }
    });
    
    return response.data.data || [];
  } catch (err) {
    console.error(`Lỗi lấy stories: ${err.response?.data?.error?.message || err.message}`);
    return [];
  }
}

async function getStoryById(storyId) {
  const token = getAccessToken();
  
  try {
    const response = await axios.get(`https://graph.facebook.com/v18.0/${storyId}`, {
      params: {
        access_token: token,
        fields: 'id,from,created_time,permalink_url,attachments{media,media_type,url,subattachments}'
      }
    });
    
    return response.data;
  } catch (err) {
    console.error(`Lỗi lấy story: ${err.response?.data?.error?.message || err.message}`);
    return null;
  }
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
  
  try {
    const username = extractUsernameFromUrl(profileUrl);
    if (!username) {
      console.log(`❌ Không thể extract username từ: ${profileUrl}`);
      return;
    }
    
    console.log(`📍 Đang xử lý: ${username}`);
    
    const stories = await getUserStories(username);
    
    if (!stories.length) {
      console.log(`   ℹ️  Không có story mới`);
      return;
    }
    
    console.log(`   📊 Tìm thấy ${stories.length} stories`);
    
    const folderName = `${username} - ${today}`;
    const folderPath = path.join(__dirname, 'temp', folderName);
    await fs.mkdir(folderPath, { recursive: true });
    
    let downloadedFiles = [];
    
    for (const story of stories) {
      const storyId = story.id;
      
      if (await isDownloaded(storyId, today)) {
        console.log(`   ⏭️  Đã download: ${storyId}`);
        continue;
      }
      
      // Lấy media URLs
      const attachments = story.attachments?.data || [];
      
      for (const attachment of attachments) {
        const mediaType = attachment.media_type;
        const media = attachment.media;
        
        if (!media) continue;
        
        let fileUrl = null;
        let ext = '';
        
        if (mediaType === 'photo') {
          fileUrl = media.image?.src;
          ext = 'jpg';
        } else if (mediaType === 'video') {
          fileUrl = media.source;
          ext = 'mp4';
        }
        
        if (!fileUrl) continue;
        
        const filename = `${storyId}.${ext}`;
        const filepath = path.join(folderPath, filename);
        
        const ok = await downloadFile(fileUrl, filepath);
        if (ok) {
          downloadedFiles.push(filepath);
          console.log(`   ✅ Downloaded: ${filename}`);
        }
      }
      
      await markDownloaded(storyId, today);
    }
    
    if (downloadedFiles.length > 0) {
      await zipAndSend(folderPath, folderName);
      console.log(`   📦 Gửi zip: ${downloadedFiles.length} files`);
    } else {
      await fs.rm(folderPath, { recursive: true, force: true }).catch(() => {});
      console.log(`   ℹ️  Không có file mới`);
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
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay
  }
  
  console.log(`\n✅ Hoàn tất\n`);
}

async function processSingleStory(storyUrl, ctx) {
  const today = await getTodayKey();
  
  try {
    console.log(`📖 Đang xử lý: ${storyUrl}`);
    
    const storyId = extractStoryId(storyUrl);
    if (!storyId) {
      throw new Error('Không thể extract story ID từ URL');
    }
    
    const story = await getStoryById(storyId);
    if (!story) {
      throw new Error('Không lấy được dữ liệu story - có thể token hết hạn hoặc story không tồn tại');
    }
    
    const username = story.from?.name || story.from?.id || 'Unknown';
    console.log(`   👤 Username: ${username}`);
    
    const folderName = `${username} - ${today} - SINGLE`;
    const folderPath = path.join(__dirname, 'temp', folderName);
    await fs.mkdir(folderPath, { recursive: true });
    
    let downloadedFiles = [];
    
    const attachments = story.attachments?.data || [];
    
    for (const attachment of attachments) {
      const mediaType = attachment.media_type;
      const media = attachment.media;
      
      if (!media) continue;
      
      let fileUrl = null;
      let ext = '';
      
      if (mediaType === 'photo') {
        fileUrl = media.image?.src;
        ext = 'jpg';
        console.log(`   📷 Downloading photo...`);
      } else if (mediaType === 'video') {
        fileUrl = media.source;
        ext = 'mp4';
        console.log(`   🎥 Downloading video...`);
      }
      
      if (!fileUrl) continue;
      
      const filename = `${storyId}.${ext}`;
      const filepath = path.join(folderPath, filename);
      
      const ok = await downloadFile(fileUrl, filepath);
      if (ok) {
        downloadedFiles.push(filepath);
        console.log(`   ✅ Downloaded: ${filename}`);
      }
    }
    
    if (downloadedFiles.length > 0) {
      await zipAndSend(folderPath, folderName);
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `✅ Đã tải ${downloadedFiles.length} file từ story của ${username}`);
    } else {
      await fs.rm(folderPath, { recursive: true, force: true }).catch(() => {});
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `ℹ️ Không có media từ: ${storyUrl}`);
    }
  } catch (err) {
    console.error(`❌ Lỗi:`, err);
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, `❌ Lỗi:\n${err.message}\n\n💡 Kiểm tra:\n1. /test → Test token\n2. /token → Lấy token mới`);
    throw err;
  }
}

// ──────────────────────────────────────── Server ────────────────────────────────────────
const app = express();

app.get('/', (req, res) => {
  res.send('Facebook Story Downloader Bot (Graph API) is running!');
});

const SECRET_PATH = '/telegraf/' + TELEGRAM_TOKEN.replace(/:/g, '');
app.use(bot.webhookCallback(SECRET_PATH));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server chạy trên port ${PORT}`);

  const webhookUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'your-render-app-name.onrender.com'}${SECRET_PATH}`;
  try {
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`Webhook đã set: ${webhookUrl}`);
  } catch (err) {
    console.error('Lỗi set webhook:', err);
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

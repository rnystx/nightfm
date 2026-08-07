#!/usr/bin/env node
/**
 * NightFM MCP Server - 无 Firebase 版本
 * 
 * 自带状态存储，不需要任何第三方数据库
 * 网站直接 POST 状态到本服务器，AI 通过 MCP 读取
 * 
 * 部署方式：
 *   Render.com / Railway.app / 任何支持 Node.js 的云平台
 *   Kelivo 的 MCP 配置填入：https://你的域名/mcp
 * 
 * 环境变量：
 *   NIGHTFM_ROOM  - 默认房间号（可选）
 *   PORT          - 监听端口（默认 3000）
 */

const http = require('http');
const https = require('https');
const url = require('url');

// ========== 配置 ==========
const PORT = process.env.PORT || 3000;
const DEFAULT_ROOM = process.env.NIGHTFM_ROOM || '';
const API_BASE = 'https://zm.wwoyun.cn';

// ========== 内存状态存储 ==========
// roomStates: { roomId: { songName, artist, ... } }
const roomStates = new Map();
// roomCommands: { roomId: [ { type, songId, songName, artist, timestamp } ] }
const roomCommands = new Map();

// ========== HTTP 工具 ==========
function httpGet(targetUrl) {
  return new Promise((resolve, reject) => {
    const mod = targetUrl.startsWith('https') ? https : http;
    mod.get(targetUrl, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    }).on('error', reject).on('timeout', function () {
      this.destroy();
      reject(new Error('timeout'));
    });
  });
}

// ========== MCP 工具定义 ==========
const TOOLS = [
  {
    name: 'get_current_state',
    description: '获取对方当前播放状态，包括歌曲名、歌手、当前歌词、播放进度。AI 可以通过这个工具"听到"对方在听什么歌、听到哪一句。',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '房间号，不填则使用默认房间' }
      }
    }
  },
  {
    name: 'search_songs',
    description: '搜索歌曲，返回歌曲列表和ID。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词' }
      },
      required: ['keyword']
    }
  },
  {
    name: 'play_song',
    description: '点歌！给对方播放指定的歌曲。需要先通过 search_songs 获取歌曲ID。',
    inputSchema: {
      type: 'object',
      properties: {
        song_id: { type: 'string', description: '歌曲ID' },
        song_name: { type: 'string', description: '歌曲名称（可选）' },
        artist: { type: 'string', description: '歌手名（可选）' },
        room: { type: 'string', description: '房间号，不填则使用默认房间' }
      },
      required: ['song_id']
    }
  },
  {
    name: 'get_lyrics',
    description: '获取指定歌曲的完整歌词。',
    inputSchema: {
      type: 'object',
      properties: {
        song_id: { type: 'string', description: '歌曲ID' }
      },
      required: ['song_id']
    }
  }
];

// ========== MCP 工具实现 ==========
async function getCurrentState(args) {
  const room = args.room || DEFAULT_ROOM;
  if (!room) return { content: [{ type: 'text', text: '请提供房间号（在 MCP 配置中设置 NIGHTFM_ROOM 环境变量，或传入 room 参数）' }] };

  const state = roomStates.get(room);
  if (!state) {
    return { content: [{ type: 'text', text: '房间 ' + room + ' 暂无播放状态，对方可能还没开始听歌' }] };
  }

  // 检查状态是否过期（超过 30 秒没更新）
  const age = Date.now() - (state.timestamp || 0);
  const stale = age > 30000;

  const lines = [
    '当前播放状态：',
    '━━━━━━━━━━━━━━',
    '歌曲：' + (state.songName || '未知'),
    '歌手：' + (state.artist || '未知'),
    '进度：' + formatTime(state.currentTime || 0),
    '当前歌词：' + (state.currentLyric || '（纯音乐/无歌词）'),
    '状态：' + (state.isPlaying ? '播放中' : '已暂停'),
    '更新时间：' + new Date(state.timestamp || Date.now()).toLocaleString('zh-CN'),
    stale ? '状态可能已过期（超过30秒未更新）' : '',
    '━━━━━━━━━━━━━━'
  ].filter(Boolean);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function searchSongs(args) {
  const keyword = args.keyword;
  if (!keyword) return { content: [{ type: 'text', text: '请提供搜索关键词' }] };

  try {
    const result = await httpGet(API_BASE + '/search?keywords=' + encodeURIComponent(keyword) + '&limit=10');
    if (!result.result || !result.result.songs || result.result.songs.length === 0) {
      return { content: [{ type: 'text', text: '没有找到 "' + keyword + '" 相关的歌曲' }] };
    }
    const lines = ['搜索结果 "' + keyword + '"：', '━━━━━━━━━━━━━━'];
    result.result.songs.forEach((song, i) => {
      const artists = song.ar ? song.ar.map(a => a.name).join('/') : (song.artists || []).map(a => a.name).join('/');
      const album = song.al ? song.al.name : (song.album ? song.album.name : '');
      lines.push((i + 1) + '. ' + song.name + ' - ' + artists + (album ? ' (' + album + ')' : ''));
      lines.push('   ID: ' + song.id);
    });
    lines.push('━━━━━━━━━━━━━━');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: '搜索失败：' + e.message }] };
  }
}

async function playSong(args) {
  const room = args.room || DEFAULT_ROOM;
  const songId = args.song_id;
  if (!room) return { content: [{ type: 'text', text: '请提供房间号' }] };
  if (!songId) return { content: [{ type: 'text', text: '请提供歌曲ID' }] };

  try {
    const detail = await httpGet(API_BASE + '/song/detail?ids=' + songId);
    if (!detail.songs || !detail.songs[0]) {
      return { content: [{ type: 'text', text: '找不到歌曲 ID: ' + songId }] };
    }
    const song = detail.songs[0];
    const artist = song.ar ? song.ar.map(a => a.name).join('/') : '未知';

    // 写入点歌指令
    const command = {
      type: 'play_command',
      songId: String(songId),
      songName: song.name,
      artist: artist,
      timestamp: Date.now()
    };

    if (!roomCommands.has(room)) roomCommands.set(room, []);
    roomCommands.get(room).push(command);

    // 只保留最近 10 条指令
    const cmds = roomCommands.get(room);
    if (cmds.length > 10) roomCommands.set(room, cmds.slice(-10));

    return { content: [{ type: 'text', text: '已发送点歌指令！\n' + song.name + ' - ' + artist + '\n等待播放器切换...' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: '点歌失败：' + e.message }] };
  }
}

async function getLyrics(args) {
  const songId = args.song_id;
  if (!songId) return { content: [{ type: 'text', text: '请提供歌曲ID' }] };

  try {
    const result = await httpGet(API_BASE + '/lyric?id=' + songId);
    const lrc = result.lrc && result.lrc.lyric ? result.lrc.lyric : '';
    if (!lrc) return { content: [{ type: 'text', text: '暂无歌词' }] };

    const lines = lrc.split('\n')
      .map(line => line.replace(/$$\d{2}:\d{2}\.\d{2,3}$$/g, '').trim())
      .filter(line => line.length > 0);

    return { content: [{ type: 'text', text: '歌词：\n' + lines.join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: '获取歌词失败：' + e.message }] };
  }
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ========== MCP 协议处理 ==========
const sessions = new Map();

async function handleMcpRequest(body) {
  const msg = typeof body === 'string' ? JSON.parse(body) : body;
  const id = msg.id;

  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'nightfm-mcp', version: '2.0.0' }
      }
    };
  }

  if (msg.method === 'notifications/initialized' || !msg.method) {
    return null;
  }

  if (msg.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS }
    };
  }

  if (msg.method === 'tools/call') {
    const toolName = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    let result;

    try {
      switch (toolName) {
        case 'get_current_state': result = await getCurrentState(args); break;
        case 'search_songs': result = await searchSongs(args); break;
        case 'play_song': result = await playSong(args); break;
        case 'get_lyrics': result = await getLyrics(args); break;
        default: result = { content: [{ type: 'text', text: '未知工具: ' + toolName }] };
      }
    } catch (e) {
      result = { content: [{ type: 'text', text: '执行出错: ' + e.message }] };
    }

    return { jsonrpc: '2.0', id, result };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + msg.method } };
}

// ========== HTTP 服务器 ==========
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ========== 网站状态上报 API ==========
  // POST /api/state/:room - 网站上报当前播放状态
  if (pathname.match(/^\/api\/state\/\d+$/) && req.method === 'POST') {
    const room = pathname.split('/').pop();
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const state = JSON.parse(body);
        state.timestamp = Date.now();
        roomStates.set(room, state);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // GET /api/command/:room - 网站拉取 AI 点歌指令
  if (pathname.match(/^\/api\/command\/\d+$/) && req.method === 'GET') {
    const room = pathname.split('/').pop();
    const commands = roomCommands.get(room) || [];
    // 返回并清空指令
    roomCommands.set(room, []);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ commands }));
    return;
  }

  // ========== 首页 ==========
  if (pathname === '/' || pathname === '/health') {
    const fs = require('fs');
    const path = require('path');
    const indexPath = path.join(__dirname, 'index.html');
    try {
      const html = fs.readFileSync(indexPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        name: 'nightfm-mcp',
        version: '2.0.0',
        endpoints: ['/mcp (Streamable HTTP)', '/sse (SSE transport)', '/api/state/:room (POST)', '/api/command/:room (GET)'],
        activeRooms: roomStates.size,
        defaultRoom: DEFAULT_ROOM || '未设置'
      }));
    }
    return;
  }

  // ========== SSE 端点 ==========
  if (pathname === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    const sessionId = Math.random().toString(36).slice(2);
    sessions.set(sessionId, res);

    res.write('event: endpoint\ndata: /mcp?sessionId=' + sessionId + '\n\n');

    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(keepalive);
      sessions.delete(sessionId);
    });
    return;
  }

  // ========== MCP Streamable HTTP 端点 ==========
  if (pathname === '/mcp' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      const result = await handleMcpRequest(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (pathname === '/mcp' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');

    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30000);

    req.on('close', () => clearInterval(keepalive));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path: pathname }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('🎵 NightFM MCP Server v2.0.0');
  console.log('   端口：' + PORT);
  console.log('   默认房间：' + (DEFAULT_ROOM || '未设置'));
  console.log('   MCP 端点：/' + (process.env.NIGHTFM_ROOM || 'YOUR_ROOM') + '/mcp');
  console.log('   状态 API：/api/state/:room');
  console.log('   指令 API：/api/command/:room');
});
